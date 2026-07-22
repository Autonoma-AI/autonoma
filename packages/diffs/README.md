# @autonoma/diffs

AI agents that drive the diff-analysis, healing, and review pipeline. Every agent is a subclass of `Agent` from `@autonoma/ai`, built on the same abstraction: an immutable agent class holds tools + system prompt, each call constructs a fresh `AgentLoop` subclass that carries the per-run state.

## Pipeline at a glance

| Agent | Trigger | Decides |
|---|---|---|
| `DiffsAgent` | PR diffs | Which existing tests might be affected; and authors any missing tests directly via `create_test` (mints the test case + plan + a pending generation, with a required coverage justification) |
| `HealingAgent` | Refinement loop iteration | What to do about each plan that failed this iteration (update_plan / report_bug / report_engine_limitation / report_unknown_issue / report_scenario_unsupported / remove_test). `report_bug` requires a re-grounded `suspectedCause` (explanation + `file:line` code references, each with an optional verbatim `snippet` from the agent's bash read); when the cause can't be grounded it downgrades to `report_unknown_issue` (Issue without a customer-facing Bug). `report_bug` also authors the customer-facing `report` (Expected/Actual + narrative, plus an optional `primaryScreenshot` designating the frame that best shows the bug - referenced by fetched step + before/after, resolved to a storage key by the tool) the bug page renders, grounded in evidence the agent pulls on demand via `fetch_step_evidence`; the narrative embeds specific screenshots inline by `evidence:<assetId>` token, anchored to a system-built `evidenceManifest` of only the assets the agent actually fetched (so it can never surface an image it did not pull). It is persisted on the occurrence's `Issue.report`, and the `suspectedCause` is folded into that same report at apply time so the bug page can render it as a hedged, subordinate "Suspected cause" section below the proven case. `report_scenario_unsupported` files a Bug-less Issue for a test impossible given the current scenario data (carrying a proposed scenario extension as prose) and removes the test from the suite, since it can never pass until a human extends the scenario. It only heals and culls - it never authors tests |
| `GenerationReviewer` | Every generation | Verdict (success / plan_mismatch / agent_limitation / application_bug / unknown_issue / scenario_unsupported). `application_bug` requires a `suspectedCause` grounding the bug in code; ungroundable suspicions are `unknown_issue`; a test impossible given the current scenario data (with a description anchoring intent) is `scenario_unsupported` and carries a `proposedScenarioExtension` |

All three extend `Agent<TInput, TResult, TLoop>`. Callers use `.run(input)`.

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
│                            before/after screenshots + step-output text, on demand, each returning a
│                            stable evidence token the narrative can embed inline) + result tool
└── reviewers/               GenerationReviewer, shared ReviewerLoop

src/scenario-data/           Reusable, agent-agnostic scenario-data capability:
                             resolveScenarioDataForGeneration (DB)
                             + materializeScenarioData (pure) + summarizeScenarioData (bounded
                             prompt summary). The read_scenario_entities tool discloses full
                             records on demand. The resolver shares the instance-unwrap
                             (materializeInstanceScenarioData). Shared entity-graph primitives
                             (normalizeEntities, summarizeEntities) are reused by scenario-recipe.

src/scenario-recipe/         Template-level sibling of scenario-data, for the diffs
                             analysis agent (Step 1): resolveScenarioRecipesForSnapshot (DB)
                             + materializeScenarioRecipe (pure) + summarizeScenarioRecipes
                             (bounded, per-scenario prompt summary). The
                             read_scenario_recipe_entities tool discloses full declared
                             records on demand.
```

### Recipe (template) data vs per-generation (instance) data

These two capabilities are deliberately distinct data shapes:

- **`scenario-data`** is per-subject **instance** data - the concrete rows a single
  generation's scenario instance *actually generated* (`ScenarioInstance.generatedData`).
  The generation reviewer and healing use it to judge whether a
  subject's plan referenced data the scenario really seeded (a strong `agent_limitation` /
  `plan_mismatch` signal; healing gets it per failing subject so it can rewrite a plan to
  match the seed rather than report a bug).
- **`scenario-recipe`** is **recipe template** data - what each scenario is *designed to
  seed*, read from the point-in-time `ScenarioRecipeVersion.fixtureJson` for the snapshot.
  The diffs **analysis** agent uses it: analysis runs *before generation*, so no instance
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

`@autonoma/diffs` is a pure agent library: it ships the `GenerationReviewer` agent class and the loader interfaces it consumes (`ScreenshotLoader`, `VideoDownloader`), plus the prompt-building blocks (`buildGenerationReviewMessages`). All reviewer orchestration that reaches for infrastructure - the production runner (`runGenerationReview`), the concrete context loaders, and the persisters - lives in `apps/workers/diffs`. Per-step eval corpora that exercise the agents live under `apps/workers/diffs/evals`.

## Sub-packages

| Path | Purpose |
|---|---|
| `./` | Public surface listed above |
| `./analysis` | The re-homed classifier + merged-analysis-pipeline library (see below) |
| `./prepare-affected-tests` | `prepareAffectedTestGenerations` callback that queues a generation for each test the agent marked affected |
| `./env` | `@t3-oss/env-core` schema for required env vars |

## `./analysis` - the merged analysis pipeline library

`src/analysis/` is a **copy** of the classifier (`classifyRun` + its vision probes + its tools: `read_code` / `grep_code` / `git_diff` / `prior_runs` / `analyze_video` / `analyze_screenshot` / `view_step_screenshot` / `get_deployment_health`, plus the live-backend tools `run_script` / `get_preview_env` / `get_app_logs`) and the holistic finding dedup (`dedupeAnalysisFindings`), re-homed out of `packages/investigation` (issue #1599). It is the home of the merged analysis pipeline - Impact Analysis -> Investigators (parallel) -> Reconciler -> finalize - which runs on the **diffs worker** (`TaskQueue.DIFFS`). It has a single behavior: when an org has it enabled the pipeline IS that org's PR analysis, running on the branch's real pending snapshot, promoting it at finalize, and filing real Bug/Issue - replacing the diffs job for the org. It ships dormant behind two gates: a global env master switch (`ANALYSIS_AUTHORITATIVE_ENABLED`) and a per-org `OrganizationSettings.analysisEnabled`; no org is flipped.

Investigation's **selection** was deliberately NOT carried over (the copied selector is dead-on-arrival - #1510 replaces Impact Analysis with the `DiffsAgent`/`runDiffsAnalysis`, and the epic rejects the carry-forward the old selector did). The classifier's live-backend tools are kept as-is; converting them to frozen-source reads (and removing `run_script`) is deferred to #1514.

Each **Investigator** (`packages/workflow/src/workflows/investigator.workflow.ts`) is a bounded state machine: it runs + classifies its test and resolves to one `AnalysisVerdict` (`passed` / `client_bug` / `engine_artifact` / `environment_failure` / `scenario_issue` / `delete`). On a "test is wrong on a healthy app" classification it self-heals - rewrites the plan on its OWN `(snapshot, testCase)` rows and re-runs, at most once (N=2) - and an exhausted loop resolves to `delete`. The `delete` self-delete is scoped by the test's `origin`: a `pre_existing` (affected) test drops only this snapshot's assignment via `RemoveTest`; a `proposed` (authored-this-run) test is removed whole via `db.testCase.delete` (removing only the assignment would orphan a real catalog row). `selfHealAnalysisTest` / `deleteAnalysisTest` (`apps/workers/diffs/src/activities/analysis`) apply these row-local writes. Each Investigator carries the classifier's **full rich output** (`AnalysisFindingReport`: narrative, evidence, per-step run-trace frames, media keys, and the `classificationConversationUrl` - a best-effort per-slug upload of the classifier's own LLM conversation, so a wrong verdict can be debugged) onto its candidate finding rather than discarding it. `dedupeAnalysisFindings` clusters over the typed taxonomy (a merged group takes its most severe member's category), carries each member's `planEdited` fidelity signal + `origin` data tag, and picks the representative member's report (the one whose verdict is the merged category) as the merged finding's evidence.

The **Reconciler** turns the deduped findings into a DETERMINISTIC two-plane verdict, in code, never by a model (`summarizeVerdictPlanes`). The `AnalysisVerdict` taxonomy is partitioned programmatically into an **app-health** plane (`client_bug` / `passed` - the PR headline, the only plane that blocks) and a **coverage-confidence** plane (`engine_artifact` / `environment_failure` / `scenario_issue` / `delete` - never a bug, never blocking), via a `Record<AnalysisVerdict, plane>` so adding a verdict is a compile error until it is placed. The coverage plane is summarized per category plus a delete-origin split read off each finding's members: `proposed` deletes are proposed tests the run could not establish, `pre_existing` deletes are obsolete tests removed. A **constrained narration** (`narrateAnalysis`) then makes one text-only model call over the FINALIZED verdict + both planes and returns prose - it cannot re-judge, re-categorize, or alter the verdict, and a narration failure degrades to an omitted narration.

The Reconciler is the single cross-test writer and persists the run to the rich store: an `AnalysisReport` header (verdict, counts, coverage summary, narration, the Impact Analysis selection reasoning) plus a per-test `AnalysisFinding` child row (modeled on the frozen `InvestigationFinding`, carrying each finding's evidence + media keys + the classifier-conversation key + `coveredSlugs` union). It files NO user-facing rows: `AnalysisFinding` is the single source of truth for every finding, `client_bug` included (it carries its full evidence - whatHappened, rootCause, remediation, screenshot/clip keys, run trace - on the row, which is what the UI renders). `client_bug` is still the app-health plane and still drives the headline verdict; it just is not copied into `Bug`/`Issue`. (The shared `resolveOrCreateBug` / `BugMatcher` stay exported for the healing `report_bug` path and are not called from analysis.) `finalizeAnalysis` then promotes the snapshot via `TestSuiteUpdater.finalize()` -> `SnapshotDraft.activate()` and marks the `AnalysisJob` terminal.

The copied classifier still emits its 7-value `Category` and a `planFidelity` field, both untouched here: the taxonomy is resolved by a mapping layer (`routeVerdict`) rather than editing the classifier, and fidelity is derived from `planEdited` rather than consuming `planFidelity` - which is now vestigial for the merged pipeline. Teaching the copied classifier to emit the taxonomy natively and dropping `planFidelity` is deferred to the classifier-cleanup slice (#1514).

After the re-home the pipeline shares no code with the frozen `packages/investigation`, so every downstream analysis-merge change modifies this copy freely. It is exposed on a dedicated subpath because it ships its own `openModelSession`/`ModelSession` that would collide with the diffs agents' model session on the main entrypoint. The pipeline's Temporal activities + worker infra live in `apps/workers/diffs/src/activities/{analysis,classify-run}`.
