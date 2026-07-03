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
5. **writeInvestigationReport** (here) - build the markdown (verdicts + the deployed-agent comparison) and
   upload it to S3.
6. **postInvestigationPrComment** (here) - post the results as a single, self-updating PR comment
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
- `writeInvestigationReport` - `DeployedComparison` + `buildReportMarkdown` -> S3.
- `postInvestigationPrComment` - render a concise summary (category counts + client-bug headlines + a link to
  the in-app report) and upsert it on the PR via `postOrUpdateMarkerComment`. Idempotent: it scans the PR for
  a hidden `<!-- autonoma-investigation -->` marker and updates that comment in place instead of posting a
  duplicate on re-runs. The signed S3 report URL is never posted (it carries a token).
- `persistInvestigationEdits` - write the agent's add/modify edits onto the twin snapshot (`EditPersister`).
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
