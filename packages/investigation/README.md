# @autonoma/investigation

The core logic of the **shadow investigation agent** - a low-risk comparison agent that runs in parallel
with the production diffs job. For a PR it runs on its **own detached snapshot** (a baseline clone the diffs
agent never mutates), selects the affected tests **from that snapshot's pinned `TestCaseAssignment`s**, runs
each as a shadow generation **using the assignment's pinned plan**, classifies the outcome (the true cause of
pass/fail), and renders a markdown report compared against the deployed agent's result. Because selection is
scoped to the frozen snapshot, there is no time cutoff, no whole-catalog fallback, and no latest-plan lookup -
quarantined and plan-less assignments are simply skipped.

This package is **platform-agnostic logic only** - every capability (DB, S3, GitHub, the cloned repo, the
models, the preview env) is injected. The Temporal worker (`apps/workers/investigation`) wires the real
implementations; the trigger lives in `@autonoma/workflow`.

## Structure

```
src/
  schema.ts                     verdict types (Category / RunVerdict / Evidence ...)
  retry.ts                      withRetry - transient-error retry (see the WARNING in the file)
  ai/
    model-session.ts            openModelSession - metered ModelRegistry facade: OpenRouter (loop/vision) +
                                native OpenAI (classifier), with a per-run CostCollector
    persist-costs.ts            persistInvestigationCosts - flush a session's metered spend to AiCostRecord
                                rows keyed on the investigation snapshot (investigationSnapshotId)
  db/
    prior-runs.ts               PriorRuns      - has this test ever passed? (the classifier baseline)
    deployed-comparison.ts      DeployedComparison - the deployed diffs agent's result (by head SHA / by PR)
    test-catalog.ts             TestCatalog    - a snapshot's assigned tests + their pinned plans (for the selector)
    scenario-recipe.ts          ScenarioRecipe - a scenario's recipe `create` graph for a snapshot (for the diagnoser)
  preview/
    preview-secrets.ts          PreviewSecrets     - read a repo's previewkit env (AWS SDK)
    preview-environment.ts      PreviewEnvironment - PreviewAccess impl + the run_script harness (temp dir)
  logs/loki.ts                  queryLokiLogs  - app logs over the run window (fetch + zod)
  codebase/
    local-codebase-reader.ts    LocalCodebaseReader - CodebaseReader over a clone (git/rg/sed)
  classify/
    prompt.ts                   the classifier system + verdict prompts (generic, no client specifics)
    verdict-schema.ts           the model-output schema + null->undefined normalizer
    dependencies.ts             the classifier's injected capability interfaces
    tools.ts                    the 11 investigation tools (one factory fn each)
    classify-run.ts             classifyRun - the orchestrator (investigate -> commit to a verdict)
  select/
    schema.ts · prompt.ts · dependencies.ts · tools.ts
    select-tests.ts             selectAffectedTests - pick the tests a diff affects
    carry-forward.ts            CarryForwardSelector - the tests to re-run this snapshot because they did NOT
                                pass on the branch's previous twin (regression running); derived from the prior
                                twin's shadow-generation results, never the current catalog, so it can't leak a
                                post-base test. Retires a test automatically the snapshot it passes.
  persist/
    edit-persister.ts           EditPersister  - write the agent's add/modify edits onto the twin snapshot
  merge/
    merge-inputs.ts             MergeInputsReader - derive the twin's test edits + recipe create-graph edits
                                (each vs its fork-point baseline) + main's current suite/recipes
    schema.ts · prompt.ts       the reconcile MergePlan schema (test + recipe decisions) + reconciler prompts
    reconcile-merge.ts          reconcileMerge - structured passes: apply / merge / skip each test edit AND each
                                recipe edit into main (recipes reconcile in their own pass)
    merge-applier.ts            MergeApplier   - apply accepted test edits + recipe create-graphs onto a detached
                                main-proposal snapshot (never main's live suite/recipe)
  scenario-repair/
    schema.ts · prompt.ts       the ScenarioDiagnosis schema + the diagnoser prompt (generic, test-first)
    diagnose.ts                 diagnoseScenarioFailure - route a scenario-data failure: fix the test (default),
                                edit the recipe, or escalate to a client-factory change (analysis only, no mutation)
    edit-recipe.ts · -prompt.ts editRecipeCreateGraph - the diagnoser's one-shot proposal: turn a recipeChange
                                instruction into a concrete new `create` graph (the dry-run proposal for every org)
    validate-recipe-graph.ts    validateRecipeGraph - local structural + referential check (every `_ref` resolves),
                                built on @autonoma/types' canonical create-graph schema (shared with the SDK resolver)
    repair-recipe-agent.ts      repairRecipeWithAgent - the tool-using repair agent (autofix orgs): reads the
      · -prompt · -tools · -deps client's factory code + DB schema, queries the live backend, validates + dry-run-
                                seeds candidates against the real factory, and returns a factory-accepted `create`
                                graph or a handoff. Analysis + dry-runs only; the worker stages the candidate on the
                                twin (the authoritative rerun gate).
  report/markdown.ts            buildReportMarkdown - legacy markdown renderer (no longer persisted by the worker;
                                the DB island is the source of truth - used only to parse pre-island reports)
  report/report-data.ts         buildReportData - the structured UI/DB contract (findings + suggested tests)
  persist/report-persister.ts   InvestigationReportPersister - persist the report into the queryable island tables
```

## Conventions

- **Classes with constructor injection** for the stateful data modules (`PriorRuns`, `DeployedComparison`,
  `TestCatalog`, `PreviewSecrets`, `PreviewEnvironment`, `ModelRegistry`).
- **No CLIs, no raw SQL**: Prisma for the app DB, the AWS SDK for secrets/S3, `fetch` for Loki, and
  `execFile`(git/rg/sed) for the codebase reader.
- **Structured output** via `generateText({ output: Output.object({ schema }) })`.
- Every DB query has a **Testcontainers parity test**; the agents' tools have unit tests with fakes.

## Tests

```bash
pnpm --filter @autonoma/investigation test
```

DB tests use Testcontainers (a real Postgres + Prisma migrations); the rest are unit tests (mocked `fetch`,
the AI SDK `MockLanguageModelV3`, a real temp git repo for the codebase reader, a real node subprocess for
the run-script harness).
