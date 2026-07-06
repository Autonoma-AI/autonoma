# @autonoma/worker-investigation

The Temporal worker for the **shadow investigation agent** (the `investigation` task queue). It runs in
parallel with the diffs job and never interferes with it. LLM-only, like `worker-diffs`; the browser runs
happen on the existing `web` worker via the generation activity.

## Workflow

`investigationWorkflow({ snapshotId })` (defined in `@autonoma/workflow`):

1. **selectInvestigationTests** (here) - clone the repo, run the selector, create a shadow `TestGeneration`
   for each affected runnable test. Also **carries forward** (regression running) the tests that did NOT pass
   on the branch's previous twin: their slugs (from `CarryForwardSelector`, derived from the prior twin's
   shadow-generation results - never the current catalog, so no post-base test can leak in) are re-materialized
   against this snapshot's baseline and added to the run set, deduped against the diff-affected set. A carried
   test that passes here is retired automatically (it is absent from the next snapshot's non-passing set).
2. For each test: **scenarioUp** (general queue) -> **runWebGeneration** (web queue) -> **classifyInvestigationRun**
   (here) -> **scenarioDown** (general queue). A single test's failure is contained; a failed generation is
   still classified (that's the signal). If **scenarioUp** fails, the environment was never provisioned, so the
   workflow skips the browser AND the classifier and records a categorized provisioning failure
   (`environment_failure` for a missing/unreachable preview, `scenario_issue` for a seeding error) - mirroring
   the diffs generation path. This keeps `scenario up` failures out of the `classification_error` bucket.
3. **diagnoseInvestigationScenario** (here) - for every `scenario_issue` result, route the failure into a
   repair category (`fix_test` / `recipe_only` / `recipe_and_sdk` / `unknown`) using the pinned plan + the
   scenario's recipe `create` graph, and compute the concrete candidate recipe (a DRY-RUN for every org). The
   route + candidate are always surfaced in the report + PR comment.
4. **Autofix (validation step), gated per org** by `OrganizationSettings.investigationAutofixEnabled` (read in
   `selectInvestigationTests`). Only opted-in orgs pay to VALIDATE the proposed repair on the twin. **Nothing is
   written to main here** - a repair that is correct for this branch can be wrong for main + every other in-flight
   branch (the branch may have changed the schema or added a bad test), and if the PR never merges, a global write
   would break main permanently. So repairs stay branch-scoped:
   - `recipe_only`: **stageRecipeCandidateOnTwin** overwrites the twin's recipe version's `create` graph
     (branch-scoped - a real run resolves the recipe by `[scenarioId, snapshotId]`) -> re-seed + re-run ->
     **classifyInvestigationRun**. On success the candidate stays on the twin (reported validated-on-the-twin) and
     reaches main only when the PR merges (see merge-with-main below); on failure **revertTwinRecipe** restores the
     twin so a failed candidate is never carried. It is never activated on main mid-PR.
   - `fix_test`: validate the edited plan on the twin (`validatePlan`: draft plan + shadow generation, re-seed +
     re-run + edit/retry). The validated `finalPlan` is what `persistInvestigationEdits` writes onto the branch
     (twin) snapshot; it reaches main only when the PR merges (via the merge reconciler). No direct main write.
   - `recipe_and_sdk`: never auto-applied (the factory needs a client code change we can't make); the concrete
     factory change is surfaced in our existing PR comment.
5. **reconcileInvestigationFindings** (here) - clone the repo and run the tool-using reconciliation agent over the
   run's PROBLEM findings: several tests can surface the SAME underlying issue (one seed gap, one code defect), and
   the agent groups those and returns merges. Read-only; contained (a failure reports no merges). The merges are
   applied in the report step, collapsing each group into one enriched finding.
6. **writeInvestigationReport** (here) - persist the structured report into the queryable island tables
   (`InvestigationReport` + findings/suggested) via `InvestigationReportPersister`, after applying the
   reconciliation merges (`applyReconciliation`). The DB is the single source of truth; nothing is written to S3
   (the UI rendering the rows IS the human-readable report).
7. **postInvestigationPrComment** (here) - post the results as a single, self-updating PR comment
   (flag-gated, see Env). Runs after the report; a failure here is contained and never sinks the workflow.

## Activities

- `selectInvestigationTests` - clone + `selectAffectedTests` + carry-forward (`CarryForwardSelector`) + create shadow generations.
- `classifyInvestigationRun` - load the generation + media (S3), clone, wire `classifyRun`'s dependencies.
- `diagnoseInvestigationScenario` - load the pinned plan (`TestCatalog`) + recipe `create` graph
  (`ScenarioRecipe`), run `diagnoseScenarioFailure` to route a scenario failure, and compute the concrete
  candidate recipe (dry-run, `editRecipeCreateGraph`). Returns `undefined` when the test has no bound scenario.
- `stageRecipeCandidateOnTwin` - overwrite the twin recipe version's `create` graph with the candidate
  (branch-scoped) and create a fresh shadow generation to validate it. Returns `staged: false` when there's
  nothing to validate. The workflow re-runs the generation and reports whether the candidate passed; it never
  activates the candidate on main.
- `markInvestigationProgress` - fast upsert of the report row's lifecycle fields (status + coarse stage) via
  `InvestigationProgressMarker`, so the PR entry point shows a run is in flight / where it is / that it failed
  before the report exists. The workflow calls it at each stage (`selecting` -> `running` -> `reporting`) and
  flips the row to `failed` on an uncontained throw; the `completed` transition is `writeInvestigationReport`'s
  job. Best-effort by contract: the activity swallows its own errors so a progress write never sinks the run.
- `reconcileInvestigationFindings` - clone the repo, build the run's findings (the same `buildFindings` id path the
  report uses), filter to problem findings (a passing/errored test is not a duplicated bug), and run `reconcileFindings`
  (the tool-using agent: `list_findings` / `read_finding` + `read_code`/`grep_code`/`git_diff` to confirm two findings
  share a cause) over them. Returns the merges; never mutates. The report step applies them. A merged finding carries
  `coveredSlugs` (the slugs it absorbed, `length > 1`), persisted to the additive `investigation_finding.covered_slugs`
  JSONB column (Prisma typed-JSON `InvestigationCoveredSlugs`). The migration is additive/nullable, but beta shares the
  prod DB and runs no migrations - run `migrate deploy` manually before this lands on beta or the report write fails.
- `writeInvestigationReport` - `DeployedComparison` + `buildReportData` -> `applyReconciliation` (collapse the merges)
  -> `InvestigationReportPersister` (island tables), flipping the row to `completed` and clearing the stage. No S3
  write. `scripts/backfill-report-island.ts` migrates pre-island reports (legacy S3 markdown) into the tables.
- `postInvestigationPrComment` - render a concise summary (category counts + client-bug headlines + a link to
  the in-app report) and upsert it on the PR via `postOrUpdateMarkerComment`. Idempotent: it scans the PR for
  a hidden `<!-- autonoma-investigation -->` marker and updates that comment in place instead of posting a
  duplicate on re-runs. The signed S3 report URL is never posted (it carries a token).
- `persistInvestigationEdits` - write the agent's add/modify/remove edits onto the twin snapshot (`EditPersister`).
  Add/modify always run; `removals` (deleting a test whose feature the PR removed) is gated by the same
  `investigationAutofixEnabled` org flag as recipe/test-fix writes - the workflow passes them only for opted-in
  orgs, so off-flag orgs stay observe-only (the removal recommendation still shows in the report/PR comment).
- `mergeInvestigationEdits` - after a PR merges, reconcile the twin's edits into main and apply the accepted
  ones onto a detached main-proposal snapshot (`MergeInputsReader` + `reconcileMerge` + `MergeApplier`). Carries
  BOTH test edits (add/modify) AND validated scenario-recipe `create`-graph edits: the recipe reconcile is a
  separate pass (apply / merge / skip vs main's current recipe) and accepted recipes are written onto the
  proposal snapshot's recipe versions - never main's live active recipe.
- `revertTwinRecipe` - restore the twin's recipe version to its pre-stage `create` graph when a staged candidate
  fails validation, so a failed candidate is never carried into main by the merge step.

All live in `src/activities/` and satisfy `InvestigationActivities` from `@autonoma/workflow/activities`. The
merge activity runs under the `investigationMergeWorkflow`, triggered by the API on `pull_request.closed`
(merged) behind `INVESTIGATION_SHADOW_ENABLED`.

## Trigger

The parallel launch is in `apps/api` (`DiffsTriggerService`), fire-and-forget behind the
`INVESTIGATION_SHADOW_ENABLED` flag - it never blocks or fails the diffs trigger.

## Scaling

Fleet throughput is `maxReplicaCount x MAX_CONCURRENT_ACTIVITIES` - two knobs that MUST stay in sync, or the
worker starves (a 3x1 misconfiguration once made investigations take ~an hour just to start):

- **`MAX_CONCURRENT_ACTIVITIES`** (`src/index.ts`, the worker's `maxConcurrentActivityTaskExecutions`) - how
  many activities one pod runs at once. The activities are I/O-bound (LLM calls, git clones, waiting on the web
  worker / preview SDK), so a pod runs several with idle CPU; the ceiling is memory (concurrent clones + LLM
  buffers vs the 2Gi pod limit). Each activity clones into its own `mkdtemp` dir (`codebase/resolve.ts`), so
  concurrency never collides on the filesystem.
- **KEDA `maxReplicaCount`** (`deployment/apps/keda-worker-investigation.yaml`) - the pod ceiling. KEDA scales
  the worker on the Temporal `investigation` queue depth.
- **KEDA `targetQueueSize`** - keep it equal to `MAX_CONCURRENT_ACTIVITIES`. KEDA scales on raw queue depth, so
  targeting ~N queued tasks per pod (where N = per-pod concurrency) makes the pod count track real demand
  instead of demanding a whole pod per queued task.

If you change one, change the others: raising per-pod concurrency without raising `targetQueueSize` under-uses
each pod's capacity; raising `maxReplicaCount` alone still bottlenecks at one activity per pod.

## Env

`GITHUB_APP_*` (clone + PR comment), `OPENROUTER_API_KEY` + `OPENAI_API_KEY` (+ model id overrides), optional
`LOKI_URL`, and `INVESTIGATION_PR_COMMENT_ENABLED` (default OFF - gates the PR-comment activity so it never
touches real PRs until deliberately enabled), plus the shared DB / Temporal / S3 / Sentry vars. See
`src/env.ts`. The deployment reads `eks/main/production/worker-investigation`.

## v1 limitations

- `get_app_logs` (Loki) and `get_deployment_health` (k8s) are not wired yet - they return a clear
  "unavailable" note and the classifier degrades gracefully. The high-value tools (codebase, prior runs,
  run_script, preview env, vision) are fully wired.
- Web apps only (shadow generations run on the web worker); non-web tests are skipped.
- Shadow `TestGeneration` rows are real rows, but carry `shadow = true` so they are excluded from every
  user-facing generation view and from the refinement loop's per-test-case dedup/invariant. The `shadow` flag
  (not the investigation-parent snapshot filter) is the authoritative guard: shadow rows can land on the PR's
  *active* snapshot, not just the detached investigation twin, so the twin-snapshot separation alone does not
  hide them. The investigation workflow can stop mid-run and orphan un-run shadow rows in `pending`; the marker
  keeps those invisible so they never pollute the customer's UI. (A reaper for the orphaned rows is a possible
  follow-up; today they are harmless because they are filtered everywhere.)
