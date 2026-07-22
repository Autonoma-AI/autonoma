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
                 [--model <id>] [--step <name>] [--resume] [--non-interactive] \
                 [--agent <name>] [--permission-mode <default|acceptEdits|bypassPermissions>]
autonoma-planner status [--project <path>]
autonoma-planner upload [--project <path>]
```

`run` is the default and may be omitted. A run can take an hour or more; progress is saved, so you
can stop and `--resume` later.

### The dashboard (TUI)

On an interactive terminal the pipeline phase runs inside a live Ink dashboard: a horizontal
pipeline strip across the top (step status, spinner on the running step, sub-progress), the
file list on the left (each generated file with its status), and a wide document viewer showing
the file currently being written, live from disk - known documents (frontmatter, pages.json)
render as readable cards and tables instead of raw source. An IDE-style ACTIVITY panel at the
bottom streams the agent's tool calls. Navigate with arrows or `h/j/k/l` (left/right switch
between the file list and the viewer - right from the list opens the selected file; up/down
move the cursor or scroll), `f` re-follows the newest file, `g`/`G` jump top/bottom, `?` opens
a help modal explaining the current step with docs links, and Ctrl+C twice exits with progress
saved. Questions (resume?, scope selection, step failures) render as an ACTION REQUIRED modal
inside the dashboard; the terminal is handed over only for the
SDK-integration handoff below, and the dashboard comes back when the agent exits.

Piped output, CI, and `--non-interactive` keep the plain line-based output. See
`docs/ui-design-brief.md` for the design rationale and `docs/tui-plan.md` for the build plan;
`pnpm ui:gallery` steps through every dashboard state with fixture data (Tab / Shift+Tab).
Pass a past run's output directory - `pnpm ui:gallery ~/.autonoma/<slug>` - to add a scene
backed by real files, so navigation and scrolling can be tested on real documents.

`upload` re-uploads everything already generated in `~/.autonoma/<app>/` - the recipe and the
artifacts (test cases, `AUTONOMA.md`, `scenarios.md`, `entity-audit.md`) - without re-running the
whole planner. Useful when an upload failed. Both the recipe and artifact endpoints are idempotent,
so it is safe to run repeatedly. It needs the same `AUTONOMA_API_URL`, `AUTONOMA_API_TOKEN`, and
`AUTONOMA_GENERATION_ID` env vars as a run. Note that if a recipe submit fails during a run, the full
recipe JSON is also printed to stdout so it can be recovered even from an ephemeral container.

### Monorepos

The run starts by mapping your repository - discovering which folder(s) are frontends, which are
backends/data layers, and which are unrelated - so every later step scans only the relevant code
instead of the whole tree. In an interactive run you pick the frontend to test (and its backends)
from a menu. To scope non-interactively, pass:

- `--frontend <path>` - the one frontend directory to plan tests for.
- `--backends <path,path>` - comma-separated backend/data-layer directories it depends on. Omit to
  default to the dependencies the mapper inferred for that frontend.

For a single-app repo the mapper resolves the scope on its own and no flags are needed.

## SDK integration handoff (test-data step)

The "Set up test data" step wires the Autonoma SDK "environment factory" into your app so the
platform can seed and tear down realistic test data through your app's own creation code. Instead
of a copy-paste guide, the CLI hands the whole integration to your **locally-installed Claude** in
one interactive, autonomous session - like `git commit` with no `-m` opening your editor. You watch
it install the SDK, build the endpoint, write the factories, **generate the test-data recipe**, and
validate each entity itself: for every entity it runs `up`, checks your database for the new rows,
runs `down`, and checks they're gone. It drives the endpoint through the CLI's own signed client
(`autonoma-planner sdk discover|up|down`), so its checks use the exact request signing the platform
uses. When it reports the session complete, the CLI uploads the recipe it produced and continues to
test generation.

- `--agent <name>` - preselect the agent to hand off to (currently `claude`). Omit to auto-detect.
- `--permission-mode <mode>` - how much autonomy the agent runs with: `default` (approve each
  command), `acceptEdits` (auto-edit files, approve commands), or `bypassPermissions` (fully
  autonomous, the default). Both the agent and the mode you pick are persisted for `--resume`.

If no supported agent is installed (or you decline the handoff), the CLI writes the full
integration instructions to `~/.autonoma/<app>/integration-prompt.md` and pauses so you can
implement them in whatever assistant you have, then `--resume` to continue. `--non-interactive`
runs are unchanged: they emit a data-only recipe with no implementation or validation.

## Output

Artifacts are written to `~/.autonoma/<project-slug>/`:

```
~/.autonoma/<app>/
├── project-map.json  # discovered frontends/backends + the scope chosen for this run
├── AUTONOMA.md       # knowledge base
├── scenarios.md      # test-data scenario descriptions
├── entity-audit.md   # database model audit
├── recipe.json       # scenario recipes (SDK factories); the agent generates + validates it
├── integration-prompt.md  # rendered SDK-integration instructions (drives the agent + manual fallback)
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
