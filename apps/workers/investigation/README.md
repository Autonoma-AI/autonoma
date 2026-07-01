# @autonoma/worker-investigation

The Temporal worker for the **shadow investigation agent** (the `investigation` task queue). It runs in
parallel with the diffs job and never interferes with it. LLM-only, like `worker-diffs`; the browser runs
happen on the existing `web` worker via the generation activity.

## Workflow

`investigationWorkflow({ snapshotId })` (defined in `@autonoma/workflow`):

1. **selectInvestigationTests** (here) - clone the repo, run the selector, create a shadow `TestGeneration`
   for each affected runnable test.
2. For each test: **scenarioUp** (general queue) -> **runWebGeneration** (web queue) -> **classifyInvestigationRun**
   (here) -> **scenarioDown** (general queue). A single test's failure is contained; a failed generation is
   still classified (that's the signal). If **scenarioUp** fails, the environment was never provisioned, so the
   workflow skips the browser AND the classifier and records a categorized provisioning failure
   (`environment_failure` for a missing/unreachable preview, `scenario_issue` for a seeding error) - mirroring
   the diffs generation path. This keeps `scenario up` failures out of the `classification_error` bucket.
3. **writeInvestigationReport** (here) - build the markdown (verdicts + the deployed-agent comparison) and
   upload it to S3.
4. **postInvestigationPrComment** (here) - post the results as a single, self-updating PR comment
   (flag-gated, see Env). Runs after the report; a failure here is contained and never sinks the workflow.

## Activities

- `selectInvestigationTests` - clone + `selectAffectedTests` + create shadow generations.
- `classifyInvestigationRun` - load the generation + media (S3), clone, wire `classifyRun`'s dependencies.
- `writeInvestigationReport` - `DeployedComparison` + `buildReportMarkdown` -> S3.
- `postInvestigationPrComment` - render a concise summary (category counts + client-bug headlines + a link to
  the in-app report) and upsert it on the PR via `postOrUpdateMarkerComment`. Idempotent: it scans the PR for
  a hidden `<!-- autonoma-investigation -->` marker and updates that comment in place instead of posting a
  duplicate on re-runs. The signed S3 report URL is never posted (it carries a token).
- `persistInvestigationEdits` - write the agent's add/modify edits onto the twin snapshot (`EditPersister`).
- `mergeInvestigationEdits` - after a PR merges, reconcile the twin's edits into main and apply the accepted
  ones onto a detached main-proposal snapshot (`MergeInputsReader` + `reconcileMerge` + `MergeApplier`).

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
