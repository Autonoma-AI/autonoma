# SDK-integration eval

Measures the single-shot SDK-integration flow, driven by the **CLI's own** integration prompt:
given the planner's frozen artifacts, an agent (`claude -p` on Bedrock) implements the Autonoma SDK
endpoint in a client repo, **generates the test-data recipe**, and validates each entity itself by
driving the built CLI's `sdk discover|up|down` commands and checking the database - then writes a
completion marker. An agentic judge grades that against the client's real ("golden") integration.

## How a run works

```
checkout(sha)  ->  copy to sandbox  ->  git apply strip.patch  ->  commit clean baseline
   ->  render the CLI's integration prompt  ->  drive `claude -p` over the sandbox
   ->  (agent generates recipe.json + writes the completion marker)
   ->  extract agent/golden diffs  ->  stage judge trees  ->  agentic judge  ->  verdict.json
```

- **clean** (agent start) = the chosen `sha` with `strip.patch` applied (SDK removed), committed as
  a baseline so the agent's later edits diff cleanly against it.
- **golden** (judge answer key) = the pristine `sha` checkout. Never exposed to the driven agent.
- **agent** = the sandbox after the drive; `git diff <clean>` in it is the agent's integration.

The signal is the judge's code comparison (five dimensions, including `perEntityValidation` -
confirmed from the transcript) plus two deterministic harness checks recorded in `verdict.json`:
whether the agent generated a `recipe.json` and whether it wrote the completion marker. The agent
runs the CLI's `sdk` commands itself; the harness does not re-run them.

## Running

```bash
pnpm --filter @autonoma-ai/planner build   # the agent shells out to dist/index.js for `sdk` - build first

export GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY="$(cat key.pem)"
export AUTONOMA_API_TOKEN=...            # judge model calls go through the CLI proxy
export AWS_BEARER_TOKEN_BEDROCK=...      # the driven claude -p runs on Bedrock; refresh if expired

pnpm --filter @autonoma-ai/planner eval:sdk -- --repo <name> \
     [--model <bedrock-id>] [--judge-model <id>] [--timeout <min>] [--no-drive] [--no-judge]
```

Run with any host network sandbox **disabled** (the Bedrock bearer token 403s through a proxy).
`--no-drive` stops after provisioning (warms the checkout, proves the app boots). `--no-judge`
stops after the drive (diffs + transcript, no judge call).

## Authoring a case

Cases live in `../cases/<repo>/` (opensource-ignored - they hold client IP). Each holds:

| file | contents |
|------|----------|
| `input.json` | `{ "owner", "repo", "sha", "installationId" }` - coordinates only, no source |
| `strip.patch` | `git diff` after manually deleting the SDK integration at `sha` (direction: `sha` -> clean). The stripped tree MUST still boot. |
| `artifacts/` | the frozen planner artifacts fed to the agent as its spec: `AUTONOMA.md`, `entity-audit.md`, `scenarios.md`. There is no frozen `recipe.json` - the agent generates its own at run time. |
| `ENV.md` | **dev-only, advisory** boot notes for engineers (optional, see below). Not read by any harness code. |

There is no machine-read boot config: starting the app locally is the driven agent's own best-effort
job. The SDK package (`@autonoma-ai/sdk`) and default endpoint path (`/api/autonoma`) are harness
constants.

### `ENV.md` (dev-only boot notes)

A case may include a hand-written `ENV.md` capturing the verified procedure to bring that client's
app up locally (backing services, env vars, dev command, gotchas). It exists purely so an engineer
can confirm a case is bootable and debug a failed run. **Nothing in `apps/cli/evals` reads it** -
the case loaders only touch `input.json`, `context.json`, `strip.patch`, `rubrics/`, and
`artifacts/`. Keep it clearly marked advisory: the driven agent must still discover boot on its own
(that discovery is part of what the eval measures), so `ENV.md` must never become an input the agent
sees. It lives under `cases/<repo>/` (opensource-ignored), so client env specifics - including the
repo name - stay out of the public mirror. For that reason, do not name a specific case here or
elsewhere in this (committed, public) README.

To capture one: check out `sha`, delete the endpoint/factories and their reference sites (route
registration, config/env references) so the tree still boots, then
`git diff > cases/<repo>/strip.patch`.
