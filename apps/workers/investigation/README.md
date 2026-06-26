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
   still classified (that's the signal).
3. **writeInvestigationReport** (here) - build the markdown (verdicts + the deployed-agent comparison) and
   upload it to S3.

## Activities

- `selectInvestigationTests` - clone + `selectAffectedTests` + create shadow generations.
- `classifyInvestigationRun` - load the generation + media (S3), clone, wire `classifyRun`'s dependencies.
- `writeInvestigationReport` - `DeployedComparison` + `buildReportMarkdown` -> S3.

All three live in `src/activities/` and satisfy `InvestigationActivities` from `@autonoma/workflow/activities`.

## Trigger

The parallel launch is in `apps/api` (`DiffsTriggerService`), fire-and-forget behind the
`INVESTIGATION_SHADOW_ENABLED` flag - it never blocks or fails the diffs trigger.

## Env

`GITHUB_APP_*` (clone), `OPENROUTER_API_KEY` + `OPENAI_API_KEY` (+ model id overrides), optional `LOKI_URL`,
plus the shared DB / Temporal / S3 / Sentry vars. See `src/env.ts`. The deployment reads
`eks/main/production/worker-investigation`.

## v1 limitations

- `get_app_logs` (Loki) and `get_deployment_health` (k8s) are not wired yet - they return a clear
  "unavailable" note and the classifier degrades gracefully. The high-value tools (codebase, prior runs,
  run_script, preview env, vision) are fully wired.
- Web apps only (shadow generations run on the web worker); non-web tests are skipped.
- Shadow `TestGeneration` rows are real rows - see the shadow-row marker follow-up before enabling broadly.
