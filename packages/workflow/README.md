# @autonoma/workflow

Temporal-based workflow orchestration for Autonoma. Defines workflows, activities, trigger functions, and worker helpers for all test execution pipelines (generation, diffs, review).

## Package Structure

```
src/
├── index.ts                              # Public exports
├── env.ts                                # Environment variables (TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE)
├── client.ts                             # Temporal client singleton
├── task-queues.ts                        # Task queue constants (web, mobile, general)
├── types.ts                              # Shared types (WorkflowArchitecture, TestPlanItem, WorkflowRef)
├── activities/                           # Activity type definitions (one file per queue)
│   ├── index.ts                         # Re-exports + activity map interfaces (GeneralActivities, WebActivities, MobileActivities)
│   ├── general-activities.ts            # General worker activity inputs and GeneralActivities interface
│   ├── web-activities.ts                # Web worker activity inputs and WebActivities interface
│   └── mobile-activities.ts             # Mobile worker activity inputs and MobileActivities interface
├── workflows/                            # Temporal workflow definitions
│   ├── batch-generation.workflow.ts      # Parallel generation
│   ├── generation-review.workflow.ts     # Standalone generation review
│   ├── diffs.workflow.ts                 # Diffs analysis
│   ├── previewkit.workflow.ts            # Preview deploy (per PR push / redeploy / main branch)
│   └── previewkit-teardown.workflow.ts   # Preview teardown (shares the deploy workflowId = per-env mutex)
├── triggers/                             # Functions to start workflows via Temporal client
│   ├── batch-generation.ts               # triggerBatchGeneration
│   ├── generation-review.ts              # triggerGenerationReviewWorkflow
│   ├── diffs.ts                          # triggerDiffsJob
│   └── previewkit.ts                     # triggerPreviewDeploy / triggerPreviewTeardown
└── worker/
    └── create-worker.ts                  # Helper to create Temporal workers
```

## Exports

```ts
// Trigger functions - start Temporal workflows
triggerBatchGeneration(params: TriggerBatchGenerationParams): Promise<void>
triggerDiffsJob(params: TriggerDiffsJobParams): Promise<void>
triggerGenerationReviewWorkflow(generationId: string): Promise<void>

// Query functions
findLatestWorkflowByGenerationId(generationId: string): Promise<WorkflowRef | undefined>

// Worker helpers
createTemporalWorker(options: CreateWorkerOptions): Promise<Worker>

// Client
getTemporalClient(): Promise<Client>
resetTemporalClient(): void

// Types
type TriggerBatchGenerationParams
type TriggerDiffsJobParams
type TestPlanItem
type WorkflowArchitecture  // "WEB" | "IOS" | "ANDROID"
type WorkflowRef           // { workflowId, runId }
type TaskQueue             // "web" | "mobile" | "general"
```

## Usage

```ts
import {
  triggerBatchGeneration,
} from "@autonoma/workflow";

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
- **general** queue - Reviews, assignments, notifications, scenarios, diffs

The authoritative analysis workflow has one uncancellable terminal activity, `settleAnalysisRun`. It settles the
snapshot and run state before applying GitHub effects, so a failed or cancelled workflow cannot strand a pending
snapshot or an in-progress merge gate.

### Workers

Three worker types poll their respective task queues:

- **Web worker** (`apps/workers/web`) - Registers web execution activities
- **Mobile worker** (`apps/workers/mobile`) - Registers mobile execution activities
- **General worker** (`apps/workers/general`) - Registers all general activities + hosts workflow definitions

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

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TEMPORAL_ADDRESS` | No | `localhost:7233` | Temporal server gRPC address |
| `TEMPORAL_NAMESPACE` | No | `default` | Temporal namespace |

## Dependencies

- `@autonoma/logger` - Structured logging
- `@autonoma/types` - Shared types (Architecture enum)
- `@temporalio/client` - Temporal client for starting workflows
- `@temporalio/worker` - Temporal worker for executing activities
- `@temporalio/workflow` - Temporal workflow API
