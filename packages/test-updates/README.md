# @autonoma/test-updates

Manages the lifecycle of test suite updates for a branch. Handles creating snapshot drafts, applying changes (add/update/remove test cases), scheduling generation jobs, assigning generation results, and finalizing (activating) snapshots.

## Exports

### Main entry point (`@autonoma/test-updates`)

| Export | Type | Description |
|--------|------|-------------|
| `TestSuiteUpdater` | Class | Top-level orchestrator for a test suite update session |
| `createDetachedSnapshot` | Function | Clones a branch's baseline suite (pinned assignments + scenario recipe versions) into a snapshot wired to NO branch pointer - a detached fork. Used by the shadow investigation agent so its generations never touch the branch's pending/active snapshot. Returns `undefined` when there is no baseline to fork from. |
| `MissingJobProviderError` | Error | Thrown when `queuePendingGenerations` is called without a job provider |
| `IncompleteGenerationsError` | Error | Thrown when finalizing a snapshot that still has pending/queued/running generations |
| `FakeGenerationProvider` | Class | In-memory stub for tests - records fired batches |
| `SnapshotNotPendingError` | Error | Snapshot is not in "processing" state |
| `BranchAlreadyHasPendingSnapshotError` | Error | Branch already has an open draft |
| `ApplicationNotFoundError` | Error | Branch not found or does not belong to the specified organization |
| `StepsPlanMismatchError` | Error | Step list does not belong to the assigned plan |

**Types:** `GenerationProvider`, `PendingGeneration`, `GenerationJobOptions`, `TestSuiteInfo`, `SnapshotChange`

**Changes (command pattern):**

| Change class | Description |
|-------------|-------------|
| `AddTest` | Adds a test case with a plan and queues generation |
| `UpdateTest` | Updates the plan for an existing test case and queues regeneration |
| `RemoveTest` | Removes a test case from the snapshot |
| `RegenerateSteps` | Clears steps and queues a new generation for an existing plan |
| `DiscardChange` | Reverts a test case to its previous snapshot state |

### Temporal entry point (`@autonoma/test-updates/temporal`)

| Export | Type | Description |
|--------|------|-------------|
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
  organizationId: "org-456",        // optional - ownership check
});

// Apply changes
await updater.apply(new AddTest({
  name: "Login flow",
  plan: "Navigate to /login, enter credentials, click Sign In, assert dashboard is visible",
  scenarioId: "scenario-789", // optional
}));

await updater.apply(new UpdateTest({
  testCaseId: "tc-abc",
  plan: "Updated plan text",
}));

await updater.apply(new RemoveTest({ testCaseId: "tc-def" }));
```

### Queueing and assigning generations

```ts
// Fire generation jobs for all pending generations
await updater.queuePendingGenerations();

// Later, when generation results come back:
const updater = await TestSuiteUpdater.continueUpdate({ db, branchId });
const { assigned, failed } = await updater.assignGenerationResults(["gen-1", "gen-2"]);
```

`continueUpdate` loads whichever snapshot is currently pending on the branch. Inside a workflow activity that was dispatched for a specific snapshot, use `continueUpdateBySnapshot` instead so later activities keep operating on the exact snapshot the workflow started on, even if a newer trigger has since replaced the branch's pending pointer:

```ts
const updater = await TestSuiteUpdater.continueUpdateBySnapshot({ db, snapshotId });
```

### Finalizing or cancelling

```ts
// Activate the snapshot (fails if incomplete generations remain)
await updater.finalize();

// Or cancel the draft - marks the snapshot "cancelled" and clears the branch
// pointer, preserving its generations, assignments, and runs for observability
await updater.cancel();
```

### Inspecting current state

```ts
const info = await updater.currentTestSuiteInfo();
// info.testCases - array of { id, slug, name, plan, steps }

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
