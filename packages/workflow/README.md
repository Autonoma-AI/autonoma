# @autonoma/workflow

Temporal-based workflow orchestration for Autonoma. Defines workflows, activities, trigger functions, and worker helpers for all test execution pipelines (generation, diffs, review).

## Package Structure

```
src/
├── index.ts                              # Public exports
├── env.ts                                # Environment variables (TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE)
├── client.ts                             # Temporal client singleton
├── task-queues.ts                        # Task queue constants (web, mobile, general, diffs, investigation)
├── types.ts                              # Shared types (WorkflowArchitecture, TestPlanItem, WorkflowRef)
├── root-failure-message.ts               # Unwraps a Temporal failure chain - not in rules/, it imports @temporalio
├── rules/                                # Pure decision logic - no Temporal, assertable without a test server
│   ├── build-warrant.ts                 # Whether a commit warrants a preview build, and why
│   ├── refinement-max-iterations.ts     # The per-trigger iteration cap
│   └── scenario-setup-failure.ts        # Categorising a failed `scenario up`
├── observability/                        # Canonical ObservabilityContext for a workflow's subjects
│   ├── load-generation-context.ts
│   ├── load-snapshot-context.ts
│   └── preview-ids.ts                   # A deploy event -> its context groups
├── workflow-types.ts                     # WORKFLOW_TYPE names
├── preview-build-id.ts                   # The build's per-commit workflow id, shared by both starters
├── activities/                           # Activity type definitions (one file per concern)
│   ├── index.ts                         # Re-exports + the activity-map interfaces each worker satisfies
│   ├── analysis-activities.ts           # The analysis pipeline's stages
│   ├── previewkit-activities.ts         # Preview build lifecycle + the warrant's inputs
│   ├── investigation-activities.ts      # Investigation / Investigator activities
│   ├── general-activities.ts            # Scenarios, refinement, notifications
│   ├── diffs-activities.ts              # Pre-cutover diffs activities
│   ├── web-activities.ts                # Web worker
│   └── mobile-activities.ts             # Mobile worker
├── workflows/                            # Everything that runs INSIDE the workflow sandbox, and nothing else
│   ├── index.ts                          # The bundle entry point (workflowsPath resolves here)
│   ├── analysis-run.workflow.ts          # A branch's analysis run; owns the preview build warrant
│   ├── preview-build.workflow.ts         # One commit's preview build (launch -> poll -> URLs)
│   ├── report-build-warrant.ts           # The one place a build warrant is recorded
│   ├── run-analysis-stages.ts            # Investigators -> Reporter, shared past the selection
│   ├── run-investigators.ts              # The bounded Investigator fan-out
│   ├── with-analysis-run-settlement.ts   # Settle-exactly-once around a run body
│   ├── investigator.workflow.ts          # One test's investigation
│   ├── investigation.workflow.ts         # Shadow investigation (manual trigger only)
│   ├── investigation-merge.workflow.ts   # Reconcile a merged twin's edits into main
│   ├── refinement-loop.workflow.ts       # Generation refinement loop
│   ├── run-generation-pipeline.workflow.ts
│   ├── batch-generation.workflow.ts      # Parallel generation
│   ├── single-generation.workflow.ts
│   └── diffs.workflow.ts                 # Pre-cutover diffs run; nothing starts one
├── triggers/                             # Functions to start workflows via the Temporal client
│   ├── analysis-run.ts                   # triggerAnalysisRun
│   ├── preview-build.ts                  # triggerPreviewBuild
│   ├── batch-generation.ts               # triggerBatchGeneration
│   ├── investigation.ts                  # triggerInvestigationJob / triggerInvestigationMergeJob
│   ├── refinement-loop.ts                # triggerRefinementLoop
│   └── diffs.ts                          # findLatestWorkflowBySnapshotId (read path only)
└── worker/
    └── create-worker.ts                  # Helper to create Temporal workers
```

## Exports

```ts
// Trigger functions - start Temporal workflows
triggerAnalysisRun(input: AnalysisRunWorkflowInput): Promise<void>
triggerPreviewBuild(input: PreviewBuildWorkflowInput): Promise<void>
triggerBatchGeneration(params: TriggerBatchGenerationParams): Promise<void>
triggerInvestigationJob(params: TriggerInvestigationJobParams): Promise<void>
triggerInvestigationMergeJob(params: TriggerInvestigationMergeJobParams): Promise<void>
triggerRefinementLoop(params: TriggerRefinementLoopParams): Promise<void>

// Query functions
findLatestWorkflowByGenerationId(generationId: string): Promise<WorkflowRef | undefined>
findLatestWorkflowBySnapshotId(snapshotId: string): Promise<WorkflowRef | undefined>

// Worker helpers
createTemporalWorker(options: CreateWorkerOptions): Promise<Worker>

// Client
getTemporalClient(): Promise<Client>
resetTemporalClient(): void

// Types
type AnalysisRunWorkflowInput
type PreviewBuildWorkflowInput
type TriggerBatchGenerationParams
type TestPlanItem
type WorkflowArchitecture  // "WEB" | "IOS" | "ANDROID"
type WorkflowRef           // { workflowId, runId }
type TaskQueue             // "web" | "mobile" | "general" | "diffs" | "investigation"
```

## Usage

```ts
import { triggerBatchGeneration } from "@autonoma/workflow";

// Batch generation - spawns one singleGenerationWorkflow per test plan.
await triggerBatchGeneration({
    snapshotId: "snapshot-1",
    testPlans: [{ testGenerationId: "gen-1", scenarioId: "scenario-1" }],
    architecture: "WEB",
});
```

## Architecture

### Workflows

Workflows define the orchestration logic using Temporal's deterministic workflow engine. They use `proxyActivities` to dispatch work to the correct task queue:

- **web** queue - Playwright-based browser automation activities
- **mobile** queue - Appium-based device automation activities
- **general** queue - Scenarios, refinement, notifications, and the preview build lifecycle
- **diffs** queue - The analysis pipeline's stages, which clone the repository
- **investigation** queue - The shadow investigation agent

The authoritative analysis workflow has one uncancellable terminal activity, `settleAnalysisRun`. It settles the
snapshot and run state before applying GitHub effects, so a failed or cancelled workflow cannot strand a pending
snapshot or an in-progress merge gate.

One workflow runs that pipeline: `analysisRunWorkflow`, keyed on the branch with a terminate-existing policy so the
newest commit displaces whatever was in flight. Its input is just `{ branchId, headSha, baseSha? }` - who hosts the
preview is a fact about the application, resolved by the run's first activity, not something a caller passes in:

- **absent** - the CUSTOMER deploys the preview, so its URL already exists when the trigger arrives and the run is
  Impact Analysis -> Investigators -> Reporter -> settle.
- **present** - WE build the preview, so the run owns the build and warrants it on the analysis. Impact Analysis is
  source-only (it clones the head sha and reads the diff), so it runs FIRST and a commit on a branch that has never
  had a preview, whose diff selects no test, skips the build+deploy entirely. Every other case builds
  unconditionally, and there the build starts before the run is opened, so no fallible step sits in front of a
  refresh the customer is owed.

The build itself is `previewBuildWorkflow`, a child keyed per COMMIT: the run decides WHETHER to build, the child
owns HOW. A child cannot terminate a running same-id workflow, so two pushes must never share an id; superseding
stays with the launcher's per-(repo, PR) `previewkit.dev/env` label mutex, and a superseded build is cancelled by
Job name.

Waiting for that build asks two questions, not one. `readPreviewBuildStatus` reports what the environment and
per-commit build rows say, and its `missing` means only "nothing recorded YET" - a runner that DECLINES to deploy
(the repo is not linked to an Application, or it has no preview config) exits 0 having written no row, so `missing`
is equally what "never" looks like. `readPreviewBuildJobState` supplies the other half from the Job object itself,
and the poll reads it FIRST, so a Job that had already ended cannot have written a row in between. The refusals that
are knowable up front are refused by `launchPreviewBuild` before a pod is scheduled at all. What is left for the
30-minute claim timeout is a Job that never reports an end - which is what it was sized for.

Past the selection both are identical, which is why the stages past it live in `workflows/run-analysis-stages.ts`
and the settle-exactly-once contract in `workflows/with-analysis-run-settlement.ts`.

### Workers

Each worker polls its own task queue:

- **Web worker** (`apps/workers/web`) - Web execution activities
- **Mobile worker** (`apps/workers/mobile`) - Mobile execution activities
- **General worker** (`apps/workers/general`) - General activities plus the preview build's, and hosts the build
  workflow. It is the pod that holds RBAC to create previewkit build Jobs.
- **Diffs worker** (`apps/workers/diffs`) - The analysis pipeline's stages; runs one activity at a time because
  each clones a repository
- **Investigation worker** (`apps/workers/investigation`) - The shadow investigation agent

### Activity Types

Activities are defined as typed stubs in `src/activities/`. Workers provide the actual implementations. This allows the workflow package to reference activity signatures without importing heavy engine dependencies.

## Testing

`pnpm test` runs the real workflows against Temporal's time-skipping test server with mocked activities - no database
and no Temporal deployment required.

The workflow bundle is expensive to build (webpack, ~4MB, up to ~75s on a contended CI runner), so `test/global-setup.ts`
builds it **once per run** before any suite starts. A worker that hosts workflows must therefore take the prebuilt
bundle rather than bundle its own:

```ts
const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TaskQueue.DIFFS,
    workflowBundle: workflowBundle(), // test/fixtures/workflow-bundle.ts - never `workflowsPath` here
    activities,
});
```

Workers that only host activities need no bundle. Start the environment with `createTimeSkippingTestEnvironment()` (it
pins the test server version and retries a failed download), and tear a suite down with
`teardownTestWorkflowEnvironment({ env, workers, runner })` so a half-finished `beforeAll` cannot bury its own error.

Two more fixtures exist because CI runs these suites on a 4-vCPU runner shared with every other package's tests, where
everything Temporal-related is 30-80x slower than locally:

- **`warmUpWorkflowWorker(execute)`** - end `beforeAll` with it. A new worker only executes its first workflow after it
  starts polling and evaluates the bundle in a fresh VM context, which measured 50-90s on that runner. Landing that on
  whichever test runs first blew the 60s `testTimeout` for that one test while every later test finished in ~2s; the
  hook is where the wait belongs (hence its much larger timeout).
- **`terminateAbandonedExecutions(env, workflowIds)`** - call it from `afterEach` with the ids that test started. A
  `testTimeout` fails the test but does not stop the execution, and a leftover run overlapping the next test both
  interleaves in the mocked activities' script and lets the time-skipping clock jump the live test's activity past its
  heartbeat timeout. Sweeping between tests keeps one slow test's failure to one test.

Mocked activities should resolve their per-test script through `Context.current().info.workflowExecution.workflowId`
(see `investigator.workflow.test.ts`) rather than closing over one shared object, so a late activity from an abandoned
run records into its own harness even if the sweep has not reached it yet.

## Environment Variables

| Variable                | Required | Default          | Description                                                       |
| ----------------------- | -------- | ---------------- | ----------------------------------------------------------------- |
| `TEMPORAL_ADDRESS`      | No       | `localhost:7233` | Temporal server gRPC address                                      |
| `TEMPORAL_NAMESPACE`    | No       | `default`        | Temporal namespace                                                |
| `TEMPORAL_METRICS_PORT` | No       | unset            | Port for the SDK's Prometheus exporter. Unset = no exporter bound |

## Worker memory: the workflow cache cap

`createTemporalWorker` sets `maxCachedWorkflows` explicitly, and that is
load-bearing rather than tidiness. Left unset, the SDK derives the cache size
from V8's heap limit and budgets ~1.7MiB per cached workflow. Our workflows cost
roughly 34MiB each, so the derived value over-commits by ~20x (539 on a 2Gi pod).
The cache fills the **workflow thread's** heap - not the pod's cgroup - and the
thread dies with `ERR_WORKER_OUT_OF_MEMORY`, taking the worker process with it.

The derivation scales with the heap, which scales with the pod's memory limit, so
**raising a worker's memory does not fix this**: it raises the ceiling and the
cache grows into it. Only the explicit cap bounds it. Read
`temporal_sticky_cache_size` (exposed via `TEMPORAL_METRICS_PORT`) before changing
the cap; a queue whose workflows are long-lived - one that polls for hours rather
than completing in seconds - keeps far more workflows resident per pod than a
short-lived one and is what makes this bite.

## Dependencies

- `@autonoma/logger` - Structured logging
- `@autonoma/types` - Shared types (Architecture enum)
- `@temporalio/client` - Temporal client for starting workflows
- `@temporalio/worker` - Temporal worker for executing activities
- `@temporalio/workflow` - Temporal workflow API
