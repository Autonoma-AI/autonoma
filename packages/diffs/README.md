# @autonoma/diffs

AI agents that drive the diff-analysis, healing, and review pipeline. Every agent is a subclass of `Agent` from `@autonoma/ai`, built on the same abstraction: an immutable agent class holds tools + system prompt, each call constructs a fresh `AgentLoop` subclass that carries the per-run state.

## Pipeline at a glance

| Agent | Trigger | Decides |
|---|---|---|
| `DiffsAgent` | PR diffs | Which existing tests might be affected; and authors any missing tests directly via `create_test` (mints the test case + plan + a pending generation, with a required coverage justification) |
| `HealingAgent` | Refinement loop iteration | What to do about each plan that failed this iteration (update_plan / report_bug / report_engine_limitation / report_unknown_issue / report_scenario_unsupported / remove_test). `report_bug` requires a re-grounded `suspectedCause` (explanation + `file:line` code references, each with an optional verbatim `snippet` from the agent's bash read); when the cause can't be grounded it downgrades to `report_unknown_issue` (Issue without a customer-facing Bug). `report_bug` also authors the customer-facing `report` (Expected/Actual + narrative, plus an optional `primaryScreenshot` designating the frame that best shows the bug - referenced by fetched step + before/after, resolved to a storage key by the tool) the bug page renders, grounded in evidence the agent pulls on demand via `fetch_step_evidence`; it is persisted on the occurrence's `Issue.report`, and the `suspectedCause` is folded into that same report at apply time so the bug page can render it as a hedged, subordinate "Suspected cause" section below the proven case. `report_scenario_unsupported` files a Bug-less Issue for a test impossible given the current scenario data (carrying a proposed scenario extension as prose) and removes the test from the suite, since it can never pass until a human extends the scenario. It only heals and culls - it never authors tests |
| `GenerationReviewer` | Every generation | Verdict (success / plan_mismatch / agent_limitation / application_bug / unknown_issue / scenario_unsupported). `application_bug` requires a `suspectedCause` grounding the bug in code; ungroundable suspicions are `unknown_issue`; a test impossible given the current scenario data (with a description anchoring intent) is `scenario_unsupported` and carries a `proposedScenarioExtension` |
| `ReplayReviewer` | Every failed replay | Verdict (engine_error / application_bug / unknown_issue). Same grounding rule: `application_bug` carries a `suspectedCause`, ungroundable suspicions are `unknown_issue` |

All four extend `Agent<TInput, TResult, TLoop>`. Callers use `.run(input)`.

## Code layout

```
src/agents/
├── capabilities.ts          Loop capability interfaces (CodebaseLoop, TestLookupLoop, …)
├── tools/                   Shared tools - typed against the narrowest capability they need
│   ├── codebase/            bash - single read-only shell tool, via buildCodebaseTools() (CodebaseLoop)
│   ├── lookup/              list_flows, list_tests, read_tests, list_scenarios, read_scenario
│   ├── scenario/            read_scenario_entities (ScenarioDataLoop),
│   │                        read_scenario_recipe_entities (ScenarioRecipeLoop)
│   ├── screenshot/          view_step_screenshot (annotates the before screenshot with the
│   │                        engine's resolved click point, web only), view_final_screenshot
│   └── subagent/            Nested research agent + tool wrapper
├── diffs/                   DiffsAgent + its action tools + result tool + prompt
├── healing/                 HealingAgent + tools (incl. fetch_step_evidence: per-step
│                            before/after screenshots + step-output text, on demand) + result tool
└── reviewers/               GenerationReviewer, ReplayReviewer, shared ReviewerLoop

src/scenario-data/           Reusable, agent-agnostic scenario-data capability:
                             resolveScenarioDataForRun / resolveScenarioDataForGeneration (DB)
                             + materializeScenarioData (pure) + summarizeScenarioData (bounded
                             prompt summary). The read_scenario_entities tool discloses full
                             records on demand. Both resolvers share the instance-unwrap
                             (materializeInstanceScenarioData). Shared entity-graph primitives
                             (normalizeEntities, summarizeEntities) are reused by scenario-recipe.

src/scenario-recipe/         Template-level sibling of scenario-data, for the diffs
                             analysis agent (Step 1): resolveScenarioRecipesForSnapshot (DB)
                             + materializeScenarioRecipe (pure) + summarizeScenarioRecipes
                             (bounded, per-scenario prompt summary). The
                             read_scenario_recipe_entities tool discloses full declared
                             records on demand.
```

### Recipe (template) data vs per-run (instance) data

These two capabilities are deliberately distinct data shapes:

- **`scenario-data`** is per-subject **instance** data - the concrete rows a single run's
  or generation's scenario instance *actually generated* (`ScenarioInstance.generatedData`).
  The replay and generation reviewers and healing use it to judge whether a
  subject's plan referenced data the scenario really seeded (a strong `engine_error` /
  `plan_mismatch` signal; healing gets it per failing subject so it can rewrite a plan to
  match the seed rather than report a bug).
- **`scenario-recipe`** is **recipe template** data - what each scenario is *designed to
  seed*, read from the point-in-time `ScenarioRecipeVersion.fixtureJson` for the snapshot.
  The diffs **analysis** agent uses it: analysis runs *before any replay*, so no instance
  exists yet - the recipe is the only artifact describing each scenario's data. Field values
  may still be unresolved variable placeholders (e.g. `{{testRunId}}`).

Both resolve their payload at setup (the only DB-touching step), inline a bounded summary,
and disclose full records on demand via an in-memory tool, keeping the agent run DB-free.

Each agent's directory contains: the `Agent` subclass, a `Loop` subclass that implements the capability interfaces the agent's tools depend on, the per-agent action/result tools, and the prompt source.

## Adding a new tool

1. Decide which capability interface(s) the tool reads off the loop. If it needs the codebase, type it against `CodebaseLoop`; if it needs the test list, `TestLookupLoop`; etc.
2. Create a file under `agents/tools/<category>/<name>-tool.ts` that exports a class extending `AgentTool<TInput, TOutput, TLoop>`.
3. Register the tool in the relevant agent's constructor (or in multiple agents if it's shared).

For action tools, push to the loop's public mutable fields directly (`loop.affectedTests.push(...)`); for cross-tool invariants, either inline the check or extract a free helper alongside the tool. The loop subclasses expose their state as `public readonly` fields - there is no separate "collector" abstraction.

## Bash tool

The `bash` tool (`agents/tools/codebase/bash-tool.ts`) lets the research agents run shell commands against the clone. It runs each command with `sh -c`, with the working directory pinned to the clone root and a scrubbed environment (`buildSafeEnv` passes only `PATH`/`HOME`/`LANG`, so worker secrets never reach the child), a 30s timeout, and head+tail output truncation.

**There is no process isolation.** The command allowlist + grammar validator (`validateCommand`) and the scrubbed environment are the only gates. The allowlist is a first gate and ergonomic guidance, **not** a security boundary: several allowed verbs (`find -exec`, `sed -i`, `awk 'system()'`, `git` write subcommands) can write, execute, or reach the network within a single validated invocation. The tool therefore trusts its own agent and runs against the user's own clone; the residual risk (writes to the worker filesystem, network egress, host-path reads outside the clone) is accepted.

> This previously wrapped the child in [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) for full process isolation, but `bwrap` requires unprivileged user namespaces that are blocked on the worker nodes (every command failed with `Creating new namespace failed: Operation not permitted`), so the isolation was removed. If isolation is wanted back without userns, prefer pod-level controls (a `NetworkPolicy` denying egress + a read-only root filesystem `securityContext`).

## Adding a new agent

1. Create `Loop` subclass that `extends AgentLoop<TResult>` and `implements` the capability interfaces the agent's tools need.
2. Create `Agent` subclass that `extends Agent<TInput, TResult, TLoop>`. Implement `buildUserPrompt(input)` and `createLoop(input)`. Construct all tools as `private readonly` fields in the constructor.
3. If the agent has a finish tool that needs to merge collector state into the result, extend `ReportResultTool<TInput, TResult, TLoop>` and implement `buildResult(input, loop)`. Otherwise use `FinishTool<TResult>` directly.

## Error handling

Tools classify their failures explicitly:

- **Bad input the model can retry** → throw `FixableToolError` with an optional `suggestFix()` message.
- **Operation didn't succeed but the tool ran fine** (bash exit ≠ 0, file not found, no grep matches) → return success-shaped data; let the model interpret it.
- **Infra failure** → throw `FatalToolError`; the loop terminates.
- **Anything else** → caught by the default `continue_unless_fatal` policy and surfaced to the model as a fixable failure.

## Entry points

`@autonoma/diffs` is a pure agent library: it ships the `GenerationReviewer` / `ReplayReviewer` agent classes and the loader interfaces they consume (`ScreenshotLoader`, `VideoDownloader`), plus the prompt-building blocks (`buildGenerationReviewMessages`, `buildReplayReviewMessages`). All reviewer orchestration that reaches for infrastructure - the production runners (`runGenerationReview` / `runReplayReview`), the concrete context loaders, and the persisters - lives in `apps/workers/diffs`. Per-step eval corpora that exercise the agents live under `apps/workers/diffs/evals`.

## Sub-packages

| Path | Purpose |
|---|---|
| `./` | Public surface listed above |
| `./prepare-affected-tests` | `prepareAffectedTestGenerations` callback that queues a generation for each test the agent marked affected |
| `./env` | `@t3-oss/env-core` schema for required env vars |
