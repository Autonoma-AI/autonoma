# Diffs investigation - reference

Durable detail for the `diffs-investigation` skill. Column/table names reflect the
Prisma schema (`packages/db/prisma/schema.prisma`); confirm there if a query errors.
SQL uses the read-only Postgres MCP (prod replica). Sentry uses org slug **`agent`**,
region **`https://sentry.autonoma.app`**.

## Data model (what to read, in order of usefulness)

| Table (`@@map`) | Key | What it tells you |
|---|---|---|
| `diffs_job` | `snapshot_id` (PK, 1:1 snapshot) | `status`, `started_at`/`completed_at`, `failure_reason`, `analysis_reasoning`, `resolution_reasoning`, `analysis_conversation_url`, `organization_id` |
| `branch_snapshot` | `id` = snapshotId | `status`, `head_sha`, `base_sha`, `branch_id`, `created_at` (no `updated_at` column) |
| `branch` / `feature_branch_info` | `branch_id` | branch `name`, `application_id`; `feature_branch_info.pr_number` maps a branch to its PR |
| `affected_test` | (`snapshot_id`,`test_case_id`) | existing tests flagged affected: `affected_reason` (`code_change`/`merge_plan_imported`/`merge_conflict`), `reasoning`, `run_id`, `generation_id` |
| `test_case_assignment` | (`snapshot_id`,`test_case_id`) | the snapshot's test suite; `plan_id`. Runs/generations attach here (Run has no direct snapshotId). New tests the diffs agent authored via `create_test` are ordinary assignments here (coverage justification in `test_case.description`) |
| `run` | `id` | execution: `status` (`pending`/`queued`/`running`/`success`/`failed`), `assignment_id`, `plan_id`, `scenario_instance_id`, `failure` (JSON: `{kind, message}`) |
| `test_generation` | `id` | authoring: `status`, `test_plan_id`, `snapshot_id`, `failure` (JSON `{kind,...}`) |
| `previewkit_environment` / `_build` / `_app_instance` | per (repo, PR) | preview deploy state: `status`, `phase`, `error`, `head_sha`, `deployed_at`, per-app readiness |

`DiffsJob.status`: pending -> analyzing -> replaying -> resolving -> generating ->
finalizing -> completed | failed. Failure `kind`s seen on runs/generations include
system/infra (`scenario_setup`, `engine_error`) vs test-level (`replay_failed`);
run-review verdicts include `success`, `application_bug`, `agent_limitation`,
`plan_mismatch`, `engine_error`. Verify the live enums in the schema.

## DB query recipes (replace `:S` with the snapshotId)

```sql
-- 1. Job + snapshot context
SELECT d.status, d.started_at, d.completed_at, d.failure_reason,
       d.analysis_conversation_url,
       bs.head_sha, bs.base_sha, b.name AS branch, app.name AS app, o.slug
FROM diffs_job d
JOIN branch_snapshot bs ON bs.id = d.snapshot_id
JOIN branch b ON b.id = bs.branch_id
JOIN application app ON app.id = b.application_id
JOIN organization o ON o.id = d.organization_id
WHERE d.snapshot_id = ':S';

-- 2. Affected tests (new tests authored by the diffs agent are ordinary test
--    cases - their coverage justification lands in test_case.description -
--    surfaced via the assignments/generations created during analysis, query 3).
SELECT tc.name, a.affected_reason, a.run_id, a.generation_id, a.reasoning
FROM affected_test a LEFT JOIN test_case tc ON tc.id = a.test_case_id
WHERE a.snapshot_id = ':S';

-- 3. Execution outcomes for the snapshot's suite
SELECT tc.name, r.status, r.failure, r.created_at
FROM run r JOIN test_case_assignment ta ON ta.id = r.assignment_id
JOIN test_case tc ON tc.id = ta.test_case_id
WHERE ta.snapshot_id = ':S' ORDER BY r.created_at DESC;
SELECT status, test_plan_id, failure, created_at FROM test_generation WHERE snapshot_id = ':S' ORDER BY created_at;
```

## Sentry recipes

`snapshotId` is an indexed tag/attribute across `errors`, `logs`, and `spans`.

- **Errors for a job:** `search_events(dataset='errors', query='snapshotId:<id>')`.
  For a recurring issue, `get_sentry_resource(issue=...)` for occurrences/first-seen,
  and `get_issue_tag_values(tagKey='activity'|'organizationId'|'environment'|'workflowType')`
  to see distribution; aggregate windows (`statsPeriod` 1h/24h/7d) to judge whether
  something is a spike vs steady (use `sort:'-count()'`).
- **Logs for a run/trace:** `search_events(dataset='logs', query='snapshotId:<id>')` or
  `query='trace:<traceId>'` (a fetched event exposes its `trace_id`). Free-text terms
  match log messages; filter by promoted attributes (`activity:`, `environment:`,
  `repoFullName:`, `state:`...). Not every structured field is queryable - if a filter
  returns nothing, fetch the event and read its attributes/extra instead.
- **Projects a diff job touches:** `worker-diffs` (analysis/resolve/heal),
  `worker-general` (refinement/generation orchestration), `generation-reviewer` /
  `replay-reviewer`, `api` (the trigger + request logs), `previewkit` (preview deploy).
  Discover the current set with `find_projects(org='agent')`.

## Agent conversation logs (S3)

```
s3://autonoma-assets/diffs-job/{snapshotId}/analysis-conversation.json
s3://autonoma-assets/diffs-job/{snapshotId}/resolution-conversation.json
```
(also stored on the `diffs_job` row). Fetch with `aws s3 cp`. The JSON is an ordered
message list (assistant tool-calls + tool results). Read it to see which tools ran,
whether each returned real output or empty, what the agent read, and the final
`finish` reasoning - the way to tell *wrong output* (agent saw the wrong thing) from
*hard failure*.

## Temporal workflow ids

- Analysis: `diffs-analysis-{snapshotId}` (type `diffsAnalysisWorkflow`)
- Refinement: `refinement-loop-{snapshotId}` (`refinementLoopWorkflow`)
- Generation pipeline: `gen-pipeline-{loopId}-iter-{n}`; single test: `generation-{generationId}`
- Replay: `run-replay-{runId}`; preview deploy: `previewkit-{slug}-{pr}`

These appear as `workflowId` / `workflow_id` tags in Sentry. Activity-level tags
(`activity`, `activityType`) name the step (e.g. `analyzeDiffs`, `resolveDiffs`,
`runHealingAgentForRefinement`, `finalizeDiffs`, `reviewGeneration`).

## Trigger chain (when no/duplicate/stale snapshot appears)

The job is only created once the trigger route is hit. For a customer using the
preview-deploy integration, the chain is:

1. **GitHub webhook** -> `apps/api/src/github/github-http.router.ts` -> dispatched to the
   matching handler. Webhook deliveries are no longer persisted to a DB table; check the
   API logs (Sentry/Loki) for delivery and processing errors.
2. **Preview deploy** (`apps/previewkit`): env in `previewkit_environment`
   (`status`/`phase`); per-app readiness in `previewkit_app_instance`. On finalize it
   posts a GitHub **deployment status** (`success` only if all apps ready;
   environment `preview`).
3. **Customer Action** on `deployment_status` -> calls **external** `/v1/diffs/trigger`
   (API key). Internal `/v1/diffs/internal/trigger` (Previewkit service-secret) also
   exists. Either way -> `DiffsTriggerService` creates the snapshot+job.

So a missing snapshot can be: webhook not processed, preview never reached a
successful deployment status, the customer Action's guard not met, or the trigger
call failing. The integration shape is per-customer - confirm it (e.g. the repo's
`.github/workflows`) rather than assuming. `DiffsTriggerService` resolves the PR's
**live head** at trigger time and supersedes any in-flight pending snapshot.

## Config/behavior that changes - check code, don't hardcode

- Refinement iteration cap: `packages/workflow/src/workflows/refinement-loop.workflow.ts`.
- Agent step limits (incl. the code-research subagent): `packages/diffs/src/agents/...`
  and the loop in `packages/ai/src/agent/agent-loop.ts`.
- Temporal retry policies (`maximumAttempts`): per workflow in
  `packages/workflow/src/workflows/*.workflow.ts`.
- Repeated generations/replays for one snapshot are usually **refinement iterations**,
  not Temporal retries - check the iteration count and per-iteration outcomes before
  concluding "retries are misconfigured".
