# @autonoma-ai/planner

The Autonoma test planner. It analyzes any frontend codebase and generates an E2E test suite -
a knowledge base, test-data scenarios, scenario recipes, and test cases - then uploads them to
Autonoma so onboarding can continue.

## Usage

Requires **Node.js >= 22.13**. Run it in your project root:

```bash
npx @autonoma-ai/planner@latest
```

Commands:

```bash
autonoma-planner [run] [--project <path>] [--frontend <path>] [--backends <path,path>] \
                 [--model <id>] [--step <name>] [--resume] [--non-interactive]
autonoma-planner status [--project <path>]
```

`run` is the default and may be omitted. A run can take an hour or more; progress is saved, so you
can stop and `--resume` later.

### Monorepos

The run starts by mapping your repository - discovering which folder(s) are frontends, which are
backends/data layers, and which are unrelated - so every later step scans only the relevant code
instead of the whole tree. In an interactive run you pick the frontend to test (and its backends)
from a menu. To scope non-interactively, pass:

- `--frontend <path>` - the one frontend directory to plan tests for.
- `--backends <path,path>` - comma-separated backend/data-layer directories it depends on. Omit to
  default to the dependencies the mapper inferred for that frontend.

For a single-app repo the mapper resolves the scope on its own and no flags are needed.

## Output

Artifacts are written to `~/.autonoma/<project-slug>/`:

```
~/.autonoma/<app>/
├── project-map.json  # discovered frontends/backends + the scope chosen for this run
├── AUTONOMA.md       # knowledge base
├── scenarios.md      # test-data scenario descriptions
├── entity-audit.md   # database model audit
├── recipe.json       # scenario recipes (SDK factories)
└── qa-tests/         # generated test cases (markdown)
```

## Automatic upload

When started from Autonoma onboarding, the CLI uploads the artifacts itself once the run finishes -
there is no manual upload step. The recipe is submitted during the recipe-builder phase; the
remaining artifacts (test cases, `AUTONOMA.md`, `scenarios.md`, `entity-audit.md`) are uploaded at the
end of the run, and the setup is then marked complete so the onboarding UI advances automatically.

If the upload credentials are not set, the CLI just leaves the artifacts on disk and skips the upload.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `AUTONOMA_API_TOKEN` | yes | Autonoma API token. Authenticates the planner, which runs on managed Autonoma credits through our LLM proxy - no LLM key needed. Injected by the Autonoma app; create one at https://autonoma.app/settings/api-keys to run standalone. Also used to upload artifacts. |
| `OPENROUTER_MODEL` | no | Override the default model (OpenRouter-style model id, forwarded by the proxy). |
| `AUTONOMA_API_URL` | no | Base URL of the Autonoma API. Defaults to `https://autonoma.app`; override to target an alpha/preview host. |
| `AUTONOMA_GENERATION_ID` | for upload | The setup id artifacts are uploaded against. Injected by onboarding. |
| `AUTONOMA_SHARED_SECRET` | no | Per-application secret used to sign SDK/webhook requests. Injected by onboarding. |
| `AUTONOMA_DISTINCT_ID` | no | PostHog identity so CLI events join the signup funnel. Injected by onboarding. |
| `DONT_TRACK` | no | Set to `1`/`true` to disable anonymous analytics. |

`AUTONOMA_API_TOKEN` + `AUTONOMA_GENERATION_ID` together enable automatic upload (the endpoint
defaults to production unless `AUTONOMA_API_URL` is set).

## Development

```bash
pnpm install
pnpm dev          # run from source (tsx)
pnpm build        # bundle with tsup
pnpm typecheck
pnpm test
```
