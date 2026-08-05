# @autonoma/test-updates

Manages the lifecycle of test suite updates for a branch. Handles creating snapshot drafts, applying changes (add/update/remove test cases), scheduling generation jobs, assigning generation results, and finalizing (activating) snapshots.

## Exports

### Main entry point (`@autonoma/test-updates`)

| Export                                 | Type     | Description                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestSuiteUpdater`                     | Class    | Top-level orchestrator for a test suite update session                                                                                                                                                                                                                                                                                  |
| `SnapshotDraft`                        | Class    | Lower-level handle on a pending (processing) snapshot: `loadById`/`loadPending`/`start`, plus persist-only `updatePlan`/`addTestCase` (no generations queued). Used by the analysis pipeline to stage edits onto the run's own snapshot.                                                           |
| `summarizeChangesForSnapshots`         | Function | Suite-change counts (added/removed/updated) for many snapshots in one query, keyed by snapshot id. Prefer this over calling `summarizeChangesForSnapshot` per snapshot: the single-snapshot path builds the full change list, loading every assignment's test case and plan prose to produce three integers.                            |
| `settleAnalysisRunState`               | Function | Idempotently settles an authoritative analysis snapshot, its unfinished generations, and its optional `AnalysisJob`. The snapshot transition is the mutex, so a caller that loses a race receives `settled: false` and must skip external side effects.                                                                                 |
| `startAnalysisRun`                     | Function | Opens a branch's analysis run: its pending snapshot plus the `AnalysisJob` tracking it, superseding whatever run the branch had in flight. Scopes the job to the branch's own organization, so no caller passes one. Deliberately does NOT start a pipeline - the caller owns what happens next, which is what lets previewkit run source-only impact analysis before deciding whether to build a preview at all. |
| `resolveAnalysisBase`                  | Function | The sha a branch's next run diffs against - its active-snapshot head, or the caller's fallback (the PR base) for a branch never analyzed - plus whether the head already IS that base. Shared by the API trigger, which answers a merge-gate request synchronously, and by the run's own `openAnalysisRun`: they have to agree, or a run is dropped or opened empty. |
| `recordBranchDeployment`               | Function | Records where a branch's tests point and repoints the branch at it, injecting the previewkit bypass header when the URL belongs to a preview. Called at whatever moment the URL becomes known: at trigger time for a customer-deployed preview, and only once the build is live for one we build ourselves.                             |
| `autonomaHostsPreviews`                | Function | Whether Autonoma builds and hosts an application's previews, from its onboarding preview mode. Only an explicit `previewkit` choice does: `existing_deploys` and an unmade choice both mean the customer deploys their own preview and only their trigger knows the URL. The webhook entry that decides whether to open a run and the run's own `resolvePreviewTarget` must both ask through here, or a run opens against a preview nobody will record. |
| `MissingJobProviderError`              | Error    | Thrown when `queuePendingGenerations` is called without a job provider                                                                                                                                                                                                                                                                  |
| `IncompleteGenerationsError`           | Error    | Thrown when finalizing a snapshot that still has pending/queued/running generations                                                                                                                                                                                                                                                     |
| `FakeGenerationProvider`               | Class    | In-memory stub for tests - records fired batches                                                                                                                                                                                                                                                                                        |
| `SnapshotNotPendingError`              | Error    | Snapshot is not in "processing" state                                                                                                                                                                                                                                                                                                   |
| `BranchAlreadyHasPendingSnapshotError` | Error    | Branch already has an open draft                                                                                                                                                                                                                                                                                                        |
| `ApplicationNotFoundError`             | Error    | Branch not found or does not belong to the specified organization                                                                                                                                                                                                                                                                       |
| `PLAN_AUTHORING_GUIDE`                 | String   | The shared E2E test-plan authoring ruleset (mutation + functional source-of-truth assertion, allowed/banned verbs, i18n resolution). Owned here and imported directly by the diffs agent, so every authored plan meets one bar. Lives in `src/plan-authoring/`.                 |

**Types:** `GenerationProvider`, `PendingGeneration`, `GenerationJobOptions`, `TestSuiteInfo`, `SnapshotChange`, `SnapshotChangeSummary`, `SnapshotComparison`

**Changes (command pattern):**

| Change class      | Description                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AddTest`         | Adds a test case with a plan and schedules generation                                                                                                                                                                                                                                                                                                        |
| `UpdateTest`      | Updates the plan for an existing test case and queues regeneration                                                                                                                                                                                                                                                                                           |
| `ImportTest`      | Adopts an existing test case into the snapshot with a given plan and queues generation. The merge flow's counterpart to `UpdateTest`, for a test the snapshot does not assign yet (authored on a branch that merged in). Deliberately not `AddTest`: the `TestCase` already exists application-wide, and minting a second one would fork the test's identity |
| `RemoveTest`      | Removes a test case from the snapshot                                                                                                                                                                                                                                                                                                                        |
| `RegenerateSteps` | Queues a new generation for a test case's existing plan                                                                                                                                                                                                                                                                                                      |
| `DiscardChange`   | Reverts a test case to its previous snapshot state                                                                                                                                                                                                                                                                                                           |

### Temporal entry point (`@autonoma/test-updates/temporal`)

| Export                       | Type  | Description                                  |
| ---------------------------- | ----- | -------------------------------------------- |
| `TemporalGenerationProvider` | Class | Fires generation jobs via Temporal Workflows |

## Usage

### Starting and applying changes

```ts
import { TestSuiteUpdater, AddTest, UpdateTest, RemoveTest } from "@autonoma/test-updates";

// Start a new update session (creates a pending snapshot)
const updater = await TestSuiteUpdater.startUpdate({
    db,
    branchId: "branch-123",
    jobProvider: myGenerationProvider, // optional - needed for queuePendingGenerations
    organizationId: "org-456", // optional - ownership check
});

// Apply changes
await updater.apply(
    new AddTest({
        name: "Login flow",
        plan: "Navigate to /login, enter credentials, click Sign In, assert dashboard is visible",
        scenarioId: "scenario-789", // optional
    }),
);

await updater.apply(
    new UpdateTest({
        testCaseId: "tc-abc",
        plan: "Updated plan text",
    }),
);

await updater.apply(new RemoveTest({ testCaseId: "tc-def" }));
```

### Queueing generations

```ts
// Fire generation jobs for all pending generations
await updater.queuePendingGenerations();
```

A generation passing its review is the definition of "validated" - there is no replay step and nothing pins a generation's steps onto its assignment.

`continueUpdate` loads whichever snapshot is currently pending on the branch. Inside a workflow activity that was dispatched for a specific snapshot, use `continueUpdateBySnapshot` instead so later activities keep operating on the exact snapshot the workflow started on, even if a newer trigger has since replaced the branch's pending pointer:

```ts
const updater = await TestSuiteUpdater.continueUpdateBySnapshot({ db, snapshotId });
```

### Finalizing or cancelling

```ts
// Activate the snapshot (fails if incomplete generations remain)
await updater.finalize();

// Activate without running generations: discard any pending jobs first so they
// don't block activation. Onboarding uses this - it commits the uploaded tests
// without running them; they generate later when a PR triggers them.
await updater.finalize({ discardPendingGenerations: true });

// Or cancel the draft - marks the snapshot "cancelled" and clears the branch
// pointer, preserving its generations, assignments, and runs for observability
await updater.cancel();

// Or fail the draft - preserves it in history as "failed" while clearing the
// branch pointer so incomplete changes can never be promoted later.
await updater.fail();
```

### Inspecting current state

```ts
const info = await updater.currentTestSuiteInfo();
// info.testCases - array of { id, slug, name, plan }

const changes = await updater.getChanges();
// Array of { type: "added" | "removed" | "updated", testCaseId, testCaseName, ... }

const summary = await updater.getGenerationSummary();
// Array of { testCaseId, generationId, status }
```

## Architecture

### Snapshot lifecycle

```
Branch
  ├── activeSnapshot   - the currently live test suite
  └── pendingSnapshot  - the draft being edited (created by startUpdate)
```

`SnapshotDraft.start()` creates a new pending snapshot and copies all test case assignments from the active snapshot. Changes are applied against this draft. When finalized, the draft becomes the new active snapshot and the previous one is marked as superseded.

### Command pattern for changes

All mutations implement the `TestSuiteChange` abstract class with a single `apply()` method. Each change receives the `SnapshotDraft` (for DB mutations) and `GenerationManager` (for scheduling generation jobs). This keeps the `TestSuiteUpdater` thin - it just delegates to the change object.

### Generation providers

The `GenerationProvider` interface decouples job scheduling from execution:

- **`TemporalGenerationProvider`** - production provider, submits batch Temporal Workflows
- **`FakeGenerationProvider`** - test double, records fired batches in memory

### Key dependencies

- `@autonoma/db` - Prisma client for all database operations
- `@autonoma/workflow` - Temporal workflow triggering (used by `TemporalGenerationProvider`)
- `@autonoma/logger` - Structured logging via Sentry
- `@autonoma/try` - Go-style error handling

## Testing

```bash
pnpm test
```

Tests use `@autonoma/integration-test` with Testcontainers (real PostgreSQL). See `test/` for examples.
