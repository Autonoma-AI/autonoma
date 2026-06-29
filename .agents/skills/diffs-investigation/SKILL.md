---
name: diffs-investigation
description: "Orientation and playbook for investigating a diff job (DiffsJob) execution from production logs and the database - the trigger chain, Temporal workflow lifecycle, data model, where logs and agent conversations live, and how to correlate them. Use when investigating a specific diff job or snapshot, a missing/stuck/duplicate snapshot, affected tests or newly authored tests, a generation/replay/refinement outcome, or any diffs-analysis / worker-diffs / refinement-loop behavior. Read REFERENCE.md for table schemas, query recipes, and Sentry recipes."
disable-model-invocation: true
---

# Investigating diff jobs

A **diff job** analyzes one PR code change against an app's test suite: it marks
existing tests as affected, replays them, proposes/authors new tests, and heals
failures. One job == one `DiffsJob` row == one `BranchSnapshot` (1:1, keyed by
`snapshotId`). Code lives in `@autonoma/diffs` (agents), `apps/workers/diffs`
(activities), `packages/workflow` (Temporal workflows). See the `execution-agent`
and `ai-utils` skills for the agent internals; this skill is about **observing a
run after the fact**.

Treat the code as source of truth. Config values (max iterations, agent step
limits, retry policies) and exact log strings change - verify against the current
tree, don't trust remembered numbers.

## Prerequisites (tools this skill assumes)

This playbook reads from three external sources. Run `/mcp` first to see what's
actually connected in this session - **don't assume they're installed.** Each is
independently useful, so a missing one only removes that lane:

| Capability | Provides | If you don't have it |
|---|---|---|
| **Postgres MCP** (`mcp__postgres__query`, read-only prod replica) | authoritative job/snapshot/test state | Ask a teammate with DB access to run the query, or use any read-only SQL client pointed at the replica. The schema is in `packages/db/prisma/schema.prisma`, so queries are reproducible by hand. |
| **Sentry MCP** (`mcp__sentry__*`, org `agent`) | execution logs, errors, issue history | Use the Sentry web UI at `https://sentry.autonoma.app` (search `snapshotId:<id>` / `trace:<id>`); the recipes in REFERENCE.md map 1:1 to the web search bar. |
| **AWS credentials** (`aws s3 cp`) | the agent conversation JSON in S3 | Ask someone with bucket access to pull the `*-conversation.json`, or skip that lane (DB + Sentry still cover most questions). |

Set them up via the team's MCP configuration (the project `.mcp.json` / your local
Codex settings); if the connection string or DSN is wrong you'll see a config
error (bad host, missing password) rather than empty results - that's a setup
problem, not a "no data" answer. If a lane is unavailable, say so explicitly in
your findings and lean on the others rather than silently narrowing scope.

## The identifiers everything keys off

- **`snapshotId`** is the spine. The analysis workflow id is
  `diffs-analysis-{snapshotId}`; refinement is `refinement-loop-{snapshotId}`.
  Given a workflowId, strip the prefix to get the snapshotId.
- Every log line, Sentry tag, and PostHog event carries canonical IDs
  (`snapshotId`, `organizationId`, `branchId`, `workflowId`, `activity`, ...),
  flattened to top-level keys (schema: `packages/logger/src/observability-context.ts`).
  So `snapshotId:<id>` is the single best filter across DB **and** Sentry.

## Lifecycle (where a run can break)

1. **Trigger.** A snapshot+job are created by `DiffsTriggerService` when the
   `/v1/diffs/trigger` (external, API-key) or `/v1/diffs/internal/trigger`
   (Previewkit service-secret) route is hit. Customers typically wire the external
   route to a successful preview deploy (e.g. a GitHub `deployment_status` Action).
   So "no snapshot appeared" is often **upstream** of the API: webhook -> preview
   deploy -> deployment status -> trigger. Walk that chain (see REFERENCE.md).
2. **`diffsAnalysisWorkflow`** (Temporal, `worker-diffs`): `analyzeDiffs` ->
   dispatch affected-test replays -> `resolveDiffs` -> `refinementLoopWorkflow`
   child -> `finalizeDiffs`. `DiffsJob.status` walks
   pending/analyzing/replaying/resolving/generating/finalizing/completed/failed.
3. **Refinement loop** (`worker-general` + `worker-diffs`): iterates
   analyze-results -> heal -> regenerate/replay until converged or max iterations.
   Each iteration fires a generation pipeline; tests are authored via
   `singleGenerationWorkflow` and reviewed.

## Investigation playbook

Start with the **DB** (cheap, authoritative state), then **Sentry** (what
happened during execution), then **S3 conversations** (what the agent actually
saw and did). Recipes for each in REFERENCE.md.

1. **Job state:** read the `diffs_job` row - status, started/completed, and
   `failure_reason`. Resolve the snapshot's app/branch/PR/shas via `branch_snapshot`.
2. **Outcomes:** `affected_test` (marked existing tests + their `run_id`/`generation_id`)
   and the snapshot's `test_case_assignment` -> `run` / `test_generation` for execution
   results. New tests the diffs agent authored via `create_test` surface here as ordinary
   assignments (no separate candidates table).
3. **Failures:** filter Sentry (org `agent`) by `snapshotId`. Read the *underlying*
   error, not just `failure_reason` - a job-level reason can be a generic wrapper
   (e.g. a child-workflow failure) hiding the real cause one or more `cause` levels
   down, or in a sub-activity's own Sentry event.
4. **Agent behavior:** the analysis/resolution agent conversations are persisted to
   S3 at `s3://autonoma-assets/diffs-job/{snapshotId}/{analysis,resolution}-conversation.json`
   (URLs are also on the `diffs_job` row). These reveal which tools ran, what the
   agent read, and where it decided - essential when the *output* is wrong rather
   than failed.

## Gotchas (durable)

- **`failure_reason` can be vague or absent.** A `completed` job can still have
  bad/partial output; a `failed` job's reason may be a generic Temporal wrapper.
  Always corroborate with Sentry and the conversation.
- **"Superseded" is not a real failure.** A newer push for the same branch cancels
  the in-flight job and marks the old one superseded. Expect these for active repos.
- **Classify failures, don't lump them.** System/infra (e.g. scenario setup,
  engine error) vs test/logic (replay/verdict failures) vs agent-loop (step limit /
  no result) vs supersession are distinct and point at different owners.
- **A successful tool call can still return empty.** Confirm a tool actually
  produced output in the conversation before assuming the agent "saw" something; a
  silently-degraded tool can yield a plausible-but-wrong analysis with no error.
- **Verify timezones before building a timeline.** The DB stores UTC; a log UI may
  render in a local zone. Pin the offset against one known event before correlating.
- **A diff job spans services.** Relevant logs live across multiple Sentry projects
  (analysis/healing, generation, replay, the API trigger, preview deploys), not just
  `worker-diffs`. Follow the `snapshotId`/`workflowId`/trace across them.

See [REFERENCE.md](REFERENCE.md) for the data model, query recipes, Sentry recipes,
and the trigger-chain walkthrough.
