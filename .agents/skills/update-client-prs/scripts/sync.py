#!/usr/bin/env python3
"""
Sync recent client pull requests from the production DB into a Notion tracker.

Reads PRs (feature branches with a PR number) created within a time window for a
set of client organizations, dedups against rows already in the Notion database,
and creates one Notion row per new PR matching the tracker's convention:

    Name          = "[Client] #<pr>"
    Cliente       = <Client>          (select; auto-created if new)
    Link          = <linkBase>/<app_slug>/pull-requests/<pr>
    <dateProperty> = branch.created_at (UTC)
    Review Status = "Not started"

All environment-specific values (AWS secret id, Notion ids, link host, client ->
org-slug map) come from a local config file that is NOT committed. Copy
`config.example.json` to `config.local.json` and fill it in. See SKILL.md.

DB reads run in a READ ONLY transaction and require the DB host to be reachable
(Tailscale up) and AWS creds with read access to the configured secret.

Usage:
    python3 sync.py --interval "24 hours"
    python3 sync.py --interval "7 days" --clients Sandstone,Centinel
    python3 sync.py --interval "24 hours" --dry-run
"""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# config lives in the skill root (next to config.example.json), one level up
DEFAULT_CONFIG = os.path.normpath(os.path.join(HERE, "..", "config.local.json"))
LIBPQ_PSQL = "/opt/homebrew/opt/libpq/bin/psql"  # macOS/Homebrew libpq; falls back to PATH
INTERVAL_RE = re.compile(r"^\d+\s+(minute|minutes|hour|hours|day|days|week|weeks)$")
REQUIRED_KEYS = ["awsRegion", "dbSecretId", "notionDatabaseId",
                 "notionDataSourceId", "linkBase", "dateProperty", "clients"]


def load_config():
    path = os.environ.get("CLIENT_PRS_CONFIG", DEFAULT_CONFIG)
    if not os.path.exists(path):
        sys.exit(f"ERROR: config not found at {path}.\n"
                 f"Copy config.example.json to config.local.json and fill it in "
                 f"(see SKILL.md). Override the path with CLIENT_PRS_CONFIG.")
    with open(path) as f:
        cfg = json.load(f)
    missing = [k for k in REQUIRED_KEYS if k not in cfg or cfg[k] in (None, "", {})]
    if missing:
        sys.exit(f"ERROR: config {path} is missing/empty keys: {missing}")
    if any(str(v).startswith("<") for v in cfg.values() if isinstance(v, str)):
        sys.exit(f"ERROR: config {path} still has placeholder <...> values. Fill them in.")
    return cfg


def psql_bin():
    return LIBPQ_PSQL if os.path.exists(LIBPQ_PSQL) else "psql"


def get_database_url(cfg):
    r = subprocess.run(
        ["aws", "secretsmanager", "get-secret-value", "--region", cfg["awsRegion"],
         "--secret-id", cfg["dbSecretId"], "--query", "SecretString", "--output", "text"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"ERROR: could not read AWS secret {cfg['dbSecretId']}: {r.stderr.strip()}\n"
                 f"Are your AWS creds active? (e.g. aws sso login)")
    try:
        return json.loads(r.stdout)["DATABASE_URL"]
    except Exception as e:
        sys.exit(f"ERROR: secret did not contain DATABASE_URL: {e}")


def query_prs(db_url, org_slugs, interval):
    slug_list = ",".join("'" + s + "'" for s in org_slugs)
    sql = f"""
BEGIN TRANSACTION READ ONLY;
SELECT o.slug AS org_slug,
       a.slug AS app_slug,
       f.pr_number,
       to_char(b.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created
FROM branch b
JOIN feature_branch_info f ON f.branch_id = b.id
JOIN application a ON a.id = b.application_id
JOIN organization o ON o.id = a.organization_id
WHERE o.slug IN ({slug_list})
  AND a.slug NOT LIKE 'deleted-%'
  AND b.created_at >= now() - interval '{interval}'
ORDER BY o.slug, f.pr_number DESC;
COMMIT;
"""
    r = subprocess.run(
        [psql_bin(), db_url, "--csv", "-q", "-P", "pager=off", "-c", sql],
        capture_output=True, text=True,
        env={**os.environ, "PGCONNECT_TIMEOUT": "8"},
    )
    if r.returncode != 0 or "could not" in r.stderr.lower() or "timeout" in r.stderr.lower():
        sys.exit("ERROR: DB query failed. Is the DB host reachable (Tailscale up)?\n"
                 + (r.stderr.strip() or r.stdout.strip()))
    return r.stdout


def parse_rows(csv_text, slug_to_label):
    rows = []
    for line in csv_text.splitlines():
        line = line.strip()
        if not line or line.startswith("org_slug"):
            continue
        parts = line.split(",")
        if len(parts) < 4:
            continue
        org_slug, app_slug, pr, created = parts[0], parts[1], parts[2], parts[3]
        rows.append({"label": slug_to_label.get(org_slug, org_slug),
                     "app_slug": app_slug, "pr": pr, "created": created})
    return rows


def mcp_call(tool, **kwargs):
    args = ["docker", "mcp", "tools", "call", tool]
    for k, v in kwargs.items():
        args.append(f"{k}={v}")
    r = subprocess.run(args, capture_output=True, text=True)
    return r.stdout + r.stderr


def existing_keys(cfg):
    """Set of (label, pr) already in the tracker.

    API-post-search returns at most 100 results per call and is workspace-wide,
    so we MUST paginate via start_cursor (the query-data-source endpoint that
    would scope to the database is broken in this MCP build). NOTE: the docker
    CLI passes args as strings and API-post-search rejects a string page_size,
    so we omit it (defaults to 100).
    """
    keys = set()
    name_re = re.compile(r"^\[(.+?)\]\s*#(\d+)")
    cursor, pages = None, 0
    while True:
        kwargs = {"filter": json.dumps({"property": "object", "value": "page"})}
        if cursor:
            kwargs["start_cursor"] = cursor
        out = mcp_call("API-post-search", **kwargs)
        js = out.find("{")
        if js == -1:
            print("WARNING: could not read existing rows for dedup; proceeding without it.")
            return set()
        try:
            data = json.loads(out[js:])
        except Exception:
            print("WARNING: could not parse existing rows for dedup; proceeding without it.")
            return set()
        for r in data.get("results", []):
            p = r.get("parent", {})
            if (p.get("data_source_id") != cfg["notionDataSourceId"]
                    and p.get("database_id") != cfg["notionDatabaseId"]):
                continue
            title = "".join(x.get("plain_text", "")
                            for x in r.get("properties", {}).get("Name", {}).get("title", []))
            m = name_re.match(title)
            if m:
                keys.add((m.group(1), m.group(2)))
        pages += 1
        if not data.get("has_more") or pages >= 50:
            break
        cursor = data.get("next_cursor")
        if not cursor:
            break
    return keys


def create_row(cfg, label, app_slug, pr, created):
    props = {
        "Name": {"title": [{"text": {"content": f"[{label}] #{pr}"}}]},
        "Cliente": {"select": {"name": label}},
        "Link": {"url": f"{cfg['linkBase']}/{app_slug}/pull-requests/{pr}"},
        cfg["dateProperty"]: {"date": {"start": created + "Z"}},
        "Review Status": {"status": {"name": "Not started"}},
    }
    parent = {"type": "database_id", "database_id": cfg["notionDatabaseId"]}
    out = mcp_call("API-post-page", parent=json.dumps(parent), properties=json.dumps(props))
    return '"object":"page"' in out, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", required=True,
                    help='Time window, e.g. "24 hours", "3 days", "1 week".')
    ap.add_argument("--clients", default="",
                    help="Comma-separated subset of client labels (default: all in config).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Show what would be created without writing to Notion.")
    args = ap.parse_args()

    interval = args.interval.strip().lower()
    if not INTERVAL_RE.match(interval):
        sys.exit(f"ERROR: invalid --interval {args.interval!r}. "
                 f'Use forms like "24 hours", "3 days", "1 week".')

    cfg = load_config()
    clients = cfg["clients"]                       # label -> org slug
    slug_to_label = {v: k for k, v in clients.items()}

    if args.clients.strip():
        wanted = [c.strip() for c in args.clients.split(",") if c.strip()]
        unknown = [c for c in wanted if c not in clients]
        if unknown:
            sys.exit(f"ERROR: unknown client(s): {unknown}. Known: {list(clients)}")
        org_slugs = [clients[c] for c in wanted]
    else:
        org_slugs = list(clients.values())

    print(f"Window: last {interval} | clients: {[slug_to_label[s] for s in org_slugs]}")

    db_url = get_database_url(cfg)
    rows = parse_rows(query_prs(db_url, org_slugs, interval), slug_to_label)
    print(f"PRs found in DB: {len(rows)}")

    seen = existing_keys(cfg)
    new = [r for r in rows if (r["label"], r["pr"]) not in seen]
    dup = len(rows) - len(new)
    counts = {}
    for r in new:
        counts[r["label"]] = counts.get(r["label"], 0) + 1
    print(f"Already in tracker (skipped): {dup}")
    print(f"To create: {len(new)} -> " + (", ".join(f"{k}:{v}" for k, v in sorted(counts.items())) or "none"))

    if args.dry_run:
        for r in new:
            print(f"  DRY [{r['label']}] #{r['pr']}  {r['created']}Z  /app/{r['app_slug']}/...")
        return

    ok = fail = 0
    for r in new:
        success, out = create_row(cfg, r["label"], r["app_slug"], r["pr"], r["created"])
        if success:
            ok += 1
        else:
            fail += 1
            print(f"  FAIL [{r['label']}] #{r['pr']}: {out.strip().splitlines()[-1][:160]}")
    print(f"DONE created={ok} failed={fail} skipped_existing={dup}")
    if ok:
        print('Reminder: sorting is a Notion VIEW setting the API cannot set. '
              f'If not already done: tracker -> "{cfg["dateProperty"]}" column -> Sort descending.')


if __name__ == "__main__":
    main()
