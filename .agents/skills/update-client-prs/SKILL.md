---
name: update-client-prs
description: "Sync recent client pull requests from the production database into the Notion 'Client PRs' tracker. Use when the user wants to add/update client PRs in Notion for a time window (e.g. 'update client PRs for the last 24h', 'add the last 3 days of PRs for a client'). Reads the prod DB read-only and writes rows via the Notion MCP."
disable-model-invocation: true
---

# Update Client PRs (Notion tracker)

Adds rows to the Notion **Client PRs** database for pull requests that entered the platform within a time window, one row per PR, matching the existing convention. Additive only - never modifies or deletes existing rows.

## One-time setup

All environment-specific values live in a local, gitignored config (no secrets or
internal ids are committed):

```bash
cd .Codex/skills/update-client-prs
cp config.example.json config.local.json   # then fill it in
```

`config.local.json` keys:
- `awsRegion`, `dbSecretId` - AWS Secrets Manager secret (us-east-1) whose JSON has a `DATABASE_URL` pointing at the prod Postgres.
- `notionDatabaseId`, `notionDataSourceId` - the Client PRs database. Get the data source id from `API-retrieve-a-database` called with `Notion-Version: 2025-09-03` (it lists `data_sources[].id`).
- `linkBase` - URL prefix for PR links, e.g. `https://<app-host>/app` (final link is `<linkBase>/<app_slug>/pull-requests/<pr>`).
- `dateProperty` - the Notion date column name (e.g. `Created At`).
- `clients` - map of `"<Cliente label>": "<organization slug>"`. The app slug is derived automatically from the DB, so only the org slug is needed.

## Prerequisites (check before running)

1. **Notion MCP** connected as `MCP_DOCKER` (Docker MCP Toolkit gateway). Verify with `docker mcp tools call API-get-self`; the Client PRs page must be shared with that integration.
2. **DB host reachable** - it is VPC-internal, so the relevant VPN/Tailscale must be up. A query timeout means it isn't.
3. **AWS creds active** with read access to the configured secret (e.g. `aws sso login`).
4. `psql` available (libpq at `/opt/homebrew/opt/libpq/bin/psql`, or on PATH).

## Steps

1. **Ask the user for the time window** if unspecified (e.g. "24 hours", "3 days", "1 week"). Optionally ask which clients (default: all in config).
2. **Preview first** with `--dry-run`, then confirm the count - especially for high-volume repos where a day can be 50+ PRs.
3. **Run**:
   ```bash
   python3 .Codex/skills/update-client-prs/scripts/sync.py --interval "<WINDOW>"
   # optional: --clients ClientA,ClientB   |   --dry-run
   ```
4. **Report** created / skipped (already present) / failed counts.
5. **Remind about sorting**: the Notion API cannot set a view's sort. If not already configured, the user sorts once: tracker -> `<dateProperty>` column -> Sort descending (it sticks and applies to new rows).

## What the script does

- Queries the prod DB (READ ONLY tx) for feature branches with a PR number, created within the window, for the configured client orgs, excluding deleted apps.
- Dedups against rows already in the tracker (by `[Client] #<pr>` title), so re-running is safe/idempotent.
- Creates each row: `Name = [Client] #<pr>`, `Cliente` (select, auto-created if new), `Link`, `<dateProperty>` = branch `created_at` (UTC), `Review Status = "Not started"`. `Remarks` is left empty for humans.

## Adding a client

Add `"<Label>": "<org_slug>"` to `clients` in `config.local.json`. Find the slug with `SELECT name, slug FROM organization WHERE name ILIKE '%<name>%'`. No per-app config is needed.

## Known constraints (this Notion MCP build)

- `API-query-data-source` / `-retrieve-a-data-source` / `-update-a-data-source` return `invalid_request_url` (broken in this build). So: reading rows uses `API-post-search` (paginated, no `page_size` arg - the docker CLI passes it as a string which the API rejects); adding a property (column) must be done manually in Notion; the date column must already exist.
- `API-retrieve-a-database` returns `data_sources[].id` only when called with `Notion-Version: 2025-09-03`.
- Page create/update (`API-post-page` / `API-patch-page`) work normally.
