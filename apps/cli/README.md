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
autonoma-planner [run] [--project <path>] [--frontend <path>] [--backend <path>] \
                 [--model <id>] [--step <name>] [--resume] [--fresh] [--non-interactive] \
                 [--agent <claude|codex>] [--permission-mode <default|acceptEdits|bypassPermissions>]
autonoma-planner status [--project <path>]
autonoma-planner upload [--project <path>]
```

`run` is the default and may be omitted. A run can take an hour or more; progress is saved, so you
can stop and `--resume` later.

`autonoma-planner --help` documents every flag and what each step of the run does. Flags accept
`--key value` and `--key=value` alike, repeatable ones (`--backend`) also take a comma-separated
list, and a flag it does not recognize is named back with the nearest one that it does - a
misspelled `--non-interactive` would otherwise leave the run waiting on questions nobody can
answer.

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
`docs/ui-design-brief.md` for the design rationale; `pnpm ui:gallery` steps through every
dashboard state with fixture data (Tab / Shift+Tab).
Pass a past run's output directory - `pnpm ui:gallery ~/.autonoma/<slug>` - to add a scene
backed by real files, so navigation and scrolling can be tested on real documents.

`upload` re-uploads everything already generated in `~/.autonoma/<app>/` - the recipe and the
artifacts (test cases, `AUTONOMA.md`, `scenarios.md`, `entity-audit.md`) - without re-running the
whole planner. Useful when an upload failed. Both the recipe and artifact endpoints are idempotent,
so it is safe to run repeatedly. It needs the same `AUTONOMA_API_TOKEN` and `AUTONOMA_GENERATION_ID`
env vars as a run (`AUTONOMA_API_URL` stays optional - the host defaults to production). Note that if
a recipe submit fails during a run, the full recipe JSON is also printed to stdout so it can be
recovered even from an ephemeral container.

### Preview environments (when the run starts from onboarding)

A run launched from Autonoma's connect screen begins one step earlier than the pipeline
below: with the **preview environment**, a real deployment of your app that Autonoma builds
per pull request and tests against. The CLI registers the Autonoma MCP server with your
coding agent and then starts a fresh session on the job - registering first is the whole
trick, because an agent only loads its MCP servers at startup and so can never pick up one
it registered itself.

The CLI decides this from your app's onboarding status, so it only happens when there is
something to do:

- Started from the connect screen, with no preview yet: preview environment, then the
  pipeline.
- Started from **Finish setup**, or with a preview you set up by hand: straight to the
  pipeline, exactly as before.
- No `AUTONOMA_APPLICATION_ID` (a standalone run against any repo): straight to the
  pipeline, and nothing here applies.

Once a run is past the preview environment, it tells Autonoma it is driving the app, and
the web app replaces the setup steps with a note pointing you back at this terminal -
there is nothing to do in both places at once. "Take over" in the web app hands the steps
back to you; a run in progress keeps going, so stop it here too.

Completion is read from Autonoma, not from your agent - an interactive session does not
exit when its work is done, and its exit code says nothing about whether a preview
deployed. That also makes it work the same whether your previews are Autonoma-hosted, on
Vercel, or from your own pipeline. If the preview does not finish, the run continues to
generate your test suite and warns you: only scenario dry runs need a live preview.

### Monorepos

The run starts by mapping your repository - discovering which folder(s) are frontends, which are
backends/data layers, and which are unrelated - so every later step scans only the relevant code
instead of the whole tree. In an interactive run you pick the frontend to test (and its backends)
from a menu. To scope non-interactively, pass:

- `--frontend <path>` - the one frontend directory to plan tests for.
- `--backends <path,path>` - comma-separated backend/data-layer directories it depends on. Omit to
  default to the dependencies the mapper inferred for that frontend.

For a single-app repo the mapper resolves the scope on its own and no flags are needed.

### Running without a human

`--non-interactive` is the path a hosted agent takes, and it runs the whole thing in one
invocation - there is never a list of steps for a caller to sequence. Because nobody can be asked
anything, every input that would have been a question is also a flag: `--agent`, `--frontend`,
`--backend`, `--permission-mode`, `--resume`, `--fresh`.

What the run does about the questions it cannot ask:

- **It never opens a browser.** The coding agent's Autonoma connection is authorized with the
  `AUTONOMA_API_TOKEN` the run already holds. The browser sign-in is refused outright without a
  terminal rather than attempted - it would not fail, it would hang on a callback nobody triggers.
- **It says what it assumed.** Where it proceeds on an answer nobody gave - continuing from a
  previous run's output, say - it prints what was assumed and the flag that would have said
  otherwise.
- **It reports each step as it starts and finishes**, with its position in the run and how long it
  took, so the process that launched it can tell work from a stall.
- **It refuses rather than guesses** when the choice would be arbitrary: several frontends and no
  `--frontend` pauses with the flag to pass, and both coding agents installed with no `--agent`
  skips the handoff and says to name one.

## SDK integration handoff (test-data step)

The "Set up test data" step wires the Autonoma SDK "environment factory" into your app so the
platform can seed and tear down realistic test data through your app's own creation code. Instead
of a copy-paste guide, the CLI hands the whole integration to your **locally-installed coding agent**
(Claude Code or Codex CLI) in
one interactive, autonomous session - like `git commit` with no `-m` opening your editor. You watch
it install the SDK, build the endpoint, write the factories, **generate the test-data recipe**, and
validate each entity itself: for every entity it runs `up`, checks your database for the new rows,
runs `down`, and checks they're gone. It finishes by seeding two instances at once, proving your
recipe survives concurrent test runs. It drives the endpoint through the CLI's own signed client
(`autonoma-planner sdk discover|up|down`), so its checks use the exact request signing and the exact
recipe-token substitution the platform uses. All of that happens on a branch it cuts from your
repo's default branch, and it pushes the finished integration as a pull request rather than leaving
the changes loose in your working tree. When it reports the session complete, the CLI uploads
the recipe it produced and continues to test generation.

- `--agent <name>` - preselect the agent to hand off to (`claude` or `codex`). Omit to auto-detect;
  if both are installed you're prompted to pick.
- `--permission-mode <mode>` - how much autonomy the agent runs with: `default` (approve each
  command), `acceptEdits` (auto-edit files, approve commands), or `bypassPermissions` (fully
  autonomous, the default). Both the agent and the mode you pick are persisted for `--resume`. For
  Codex these map onto its sandbox/approval model (always `--sandbox danger-full-access` because the
  integration must install the SDK and reach the network, with approval strictness as the only lever;
  `bypassPermissions` uses `--dangerously-bypass-approvals-and-sandbox`).

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
    ├── INDEX.md      # table of contents for the suite
    └── _invalid/     # tests that failed structural validation; never uploaded
```

`qa-tests/INDEX.md` is written once, at the end, from the files on disk - so it always matches
the suite beside it. Alongside the totals it names what the run could *not* deliver: features it
walked without producing a test, and tests the review cycle removed that nothing could put back.
Both are fixed by re-running the planner.

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
| `AUTONOMA_APPLICATION_ID` | no | The application this run belongs to. Lets the CLI read onboarding state (so it can skip work the app has already had done) and mint pairing codes for the coding agents it hands off to. Injected by onboarding. |
| `AUTONOMA_SHARED_SECRET` | no | Per-application secret used to sign SDK/webhook requests. Injected by onboarding. |
| `AUTONOMA_DISTINCT_ID` | no | PostHog identity so CLI events join the signup funnel. Injected by onboarding. |
| `DONT_TRACK` | no | Set to `1`/`true` to disable all telemetry - events, log shipping and session replay. |

`AUTONOMA_API_TOKEN` + `AUTONOMA_GENERATION_ID` together enable automatic upload (the endpoint
defaults to production unless `AUTONOMA_API_URL` is set).

## Telemetry

Three lanes, all to PostHog, all off when `DONT_TRACK=1`:

- **Events** (`core/analytics.ts`) - `cli_run_started`, `cli_step_completed`, `$exception`, and friends,
  posted to the capture endpoint.
- **Logs** (`core/logs.ts`) - the run's narrative, shipped as OTLP records under the service name
  `autonoma-planner`: run and step lifecycle, every agent tool call, tool errors, retries and nudges,
  and everything the CLI prints to the user.
- **Session replay** (`src/replay/`) - the dashboard itself, as rrweb events, played back in PostHog's
  session-replay player.

All three lanes are indexed by the same identifiers (`core/session.ts`), so one run resolves the same
way from any of them:

| Attribute | What it identifies |
|-----------|--------------------|
| `run_id` / `sessionId` | This CLI invocation. `sessionId` is PostHog's own grouping key, so a run's logs sit together. |
| `generation_id` | The onboarding setup the run is fulfilling - the join back to an Autonoma record. |
| `posthogDistinctId` | The person, when the app launched the CLI with an identity; otherwise an anonymous per-machine device id. |
| `project_slug`, `cli_version`, `node_version` | Which project, which build, which runtime. |

To read one run: filter logs by `service.name = autonoma-planner` and the `generation_id` (or `run_id`)
you are chasing, ordered earliest-first.

Log records carry **metadata only** - step names, agent and tool names, file paths, patterns, commands,
durations, and error messages. Model prose and reasoning, prompts, and the contents of any file the
agent read or wrote are never sent; those are what would carry a user's source code off their machine.
Records are truncated and a single run is capped at 5000 of them, so a stuck agent loop cannot flood
ingestion - the cap being reached is itself logged.

### Session replay

An interactive run is recorded and plays back in PostHog's normal session-replay player, alongside web
recordings for the same person. It uses the run id as its `$session_id`, so a recording, its events and
its logs all resolve to one another.

`DONT_TRACK=1` turns it off along with the other two lanes - one switch, no partial opt-out.

**This lane captures more than the others, and it is worth being explicit about it.** Events and logs
are deliberately metadata-only - no prompts, no model prose, no file contents. A replay is a verbatim
copy of the dashboard, and the dashboard renders repository paths and the contents of the files the run
generates. Anything visible on screen is in the recording. Keystrokes are the one exception: printable
characters are recorded as a placeholder, never the literal key, so the upload is not a transcript of
the keyboard.

How it works (`src/replay/`):

- Frames come from an off-screen render of the same `<App>` the user sees, using Ink's `debug`
  mode, which writes a complete frame with no cursor escapes. Scraping the terminal repaint stream
  would not work, because Ink can emit either full redraws or per-line incremental updates.
- Each frame becomes a synthetic DOM: one `<div>` per terminal row, spans for each colour run.
- Frames are diffed row by row, so a repaint uploads only the rows that changed. A full snapshot of
  the dashboard is tens of kilobytes; a typical repaint is a few hundred bytes.
- Keystrokes are emitted as rrweb input events, because PostHog derives the active/inactive split
  from interaction events alone. Without them a run of pure repaints reads as entirely idle and the
  player's inactivity-skipping has nothing to skip to. Printable characters are recorded as a
  placeholder rather than the literal key, so the upload is not a transcript of the keyboard.
- Capture is rate limited to 2 fps, batched under PostHog's size limit, and capped per run. Any
  failure is swallowed - a recording is never worth failing a run over.

## Development

```bash
pnpm install
pnpm dev          # run from source (tsx)
pnpm build        # bundle with tsup
pnpm typecheck
pnpm test
```
