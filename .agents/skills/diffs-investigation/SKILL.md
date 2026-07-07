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

This playbook reads from three external sources - **don't assume they're set up.**
Each is independently useful, so a missing one only removes that lane:

| Capability | Provides | If you don't have it |
|---|---|---|
| **Postgres MCP** (`mcp__postgres__query`, read-only prod replica) | authoritative job/snapshot/test state | Ask a teammate with DB access to run the query, or use any read-only SQL client pointed at the replica. The schema is in `packages/db/prisma/schema.prisma`, so queries are reproducible by hand. |
| **Sentry CLI** (`sentry-cli`, org `agent`) | errors/issues, execution logs, issue history | Install (`brew install getsentry/tools/sentry-cli` or `curl -sL https://sentry.io/get-cli/ \| sh`) and configure `~/.sentryclirc` (see REFERENCE.md). Or use the web UI at `https://sentry.autonoma.app` (search `snapshotId:<id>` / `trace:<id>`); the recipes in REFERENCE.md name the equivalent search. |
| **AWS credentials** (`aws s3 cp`) | the agent conversation JSON in S3 | Ask someone with bucket access to pull the `*-conversation.json`, or skip that lane (DB + Sentry still cover most questions). |

Confirm Sentry auth with `sentry-cli info` (it should print
`Sentry Server: https://sentry.autonoma.app` and `Default Organization: agent`);
Postgres goes through its MCP. If a connection string, DSN, or auth token is wrong
you'll see a config/auth error (bad host, missing password, 401) rather than empty
results - that's a setup problem, not a "no data" answer. If a lane is unavailable,
say so explicitly in your findings and lean on the others rather than silently
narrowing scope.

## The identifiers everything keys off

- **`snapshotId`** is the spine. The analysis workflow id is
  `diffs-analysis-{snapshotId}`; refinement is `refinement-loop-{snapshotId}`.
  Given a workflowId, strip the prefix to get the snapshotId.
- Every log line, Sentry tag, and PostHog event carries canonical IDs
  (`snapshotId`, `organizationId`, `branchId`, `workflowId`, `activity`, ...),
  flattened to top-level keys (schema: `packages/logger/src/observability-context.ts`).
  So `snapshotId:<id>` is the single best filter across DB **and** Sentry.
- **Environment (`beta`/`production`/`alpha`) is NOT one of those DB-resolvable IDs.**
  All environments share one database (see the gotcha below); a job's environment
  lives only in Sentry (the `environment` tag, from `SENTRY_ENV`) and Temporal (the
  namespace / `environment` search attribute, from `NAMESPACE`) - set by whichever
  fleet processed the job. Scope by environment with `environment:<env>` in Sentry
  (alongside `organizationId:`/`snapshotId:`), never in SQL.

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
- **Production and beta (and alpha) share ONE database.** There is no environment
  column on `diffs_job`/`branch_snapshot`/`run`/`test_generation`, so a plain SQL
  count mixes all environments together. The trigger endpoint is served per-namespace
  and each client wires its webhook to one namespace's ingress, so different clients
  trigger into different environments and a single org can appear in several over time.
  Never label a DB-only result "beta" (or "prod") - it isn't. To attribute or scope by
  environment, go through Sentry (`environment:<env>`) or the Temporal namespace, then
  join back to the DB by `snapshotId`.
- **Classify failures, don't lump them.** System/infra (e.g. scenario setup,
  engine error) vs test/logic (replay/verdict failures) vs agent-loop (step limit /
  no result) vs supersession are distinct and point at different owners.
- **A successful tool call can still return empty.** Confirm a tool actually
  produced output in the conversation before assuming the agent "saw" something; a
  silently-degraded tool can yield a plausible-but-wrong analysis with no error.
- **Verify timezones before building a timeline.** All DB timestamp columns are
  `timestamp without time zone` (Prisma `DateTime`) holding a naive **UTC** instant -
  they carry no offset, so nothing labels them as UTC. Sentry renders UTC (`+00:00`),
  so the two align only if you treat the DB value as UTC. Two traps when the SQL
  session's `TimeZone` isn't UTC: (1) `now()` is `timestamptz`, so
  `col > now() - interval 'N hours'` casts the naive column using the session zone and
  silently shifts your window by the local offset; (2) `col AT TIME ZONE 'UTC'`
  re-labels an already-UTC value and, via `to_char`, shifts the *displayed* time. The
  read-only prod replica MCP runs `Etc/UTC` (safe there), but a local client
  (psql/DBeaver) usually defaults to your local zone - run `SHOW timezone;` first,
  `SET TIME ZONE 'UTC';` if needed, render UTC columns directly
  (`to_char(col, 'YYYY-MM-DD HH24:MI')`, no `AT TIME ZONE`), and pin one known Sentry
  event (UTC) against its DB row before correlating.
- **A diff job spans services.** Relevant logs live across multiple Sentry projects
  (analysis/healing, generation, replay, the API trigger, preview deploys), not just
  `worker-diffs`. Follow the `snapshotId`/`workflowId`/trace across them.

See [REFERENCE.md](REFERENCE.md) for the data model, query recipes, Sentry recipes,
and the trigger-chain walkthrough.
