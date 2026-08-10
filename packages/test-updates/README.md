# @autonoma/test-updates

> **Deprecated.** The analysis pipeline and the manual snapshot editor have both moved onto `@autonoma/test-suite`
> (the suite module); this package now serves only onboarding/CLI artifact upload and the branches presentation
> reads, and is deleted once those callers migrate. Do not add new consumers.

Manages the lifecycle of test suite updates for a branch: creating snapshot drafts, applying changes (add/remove
test cases), and finalizing (activating) snapshots. Nothing here starts a run - a run begins only through the suite
module's `startRun`.

## Exports

### Main entry point (`@autonoma/test-updates`)

| Export                                 | Type     | Description                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestSuiteUpdater`                     | Class    | Top-level orchestrator for a test suite update session                                                                                                                                                                                                                                                                                  |
| `SnapshotDraft`                        | Class    | Lower-level handle on a pending (processing) snapshot: `loadById`/`loadPending`/`start`, plus `updatePlan`/`addTestCase`.                                                                                                                                                                                                                |
| `summarizeChangesForSnapshots`         | Function | Suite-change counts (added/removed/updated) for many snapshots in one query, keyed by snapshot id. Prefer this over calling `summarizeChangesForSnapshot` per snapshot: the single-snapshot path builds the full change list, loading every assignment's test case and plan prose to produce three integers.                            |
| `recordBranchDeployment`               | Function | Records where a branch's tests point and repoints the branch at it, injecting the previewkit bypass header when the URL belongs to a preview. Called at whatever moment the URL becomes known: at trigger time for a customer-deployed preview, and only once the build is live for one we build ourselves.                             |
| `autonomaHostsPreviews`                | Function | Whether Autonoma builds and hosts an application's previews, from its onboarding preview mode. Only an explicit `previewkit` choice does: `existing_deploys` and an unmade choice both mean the customer deploys their own preview and only their trigger knows the URL. The webhook entry that decides whether to open a run and the run's own `resolvePreviewTarget` must both ask through here, or a run opens against a preview nobody will record. |
| `FakeGenerationProvider`               | Class    | In-memory stub for tests - records fired batches                                                                                                                                                                                                                                                                                        |
| `SnapshotNotPendingError`              | Error    | Snapshot is not in "processing" state                                                                                                                                                                                                                                                                                                   |
| `BranchAlreadyHasPendingSnapshotError` | Error    | Branch already has an open draft                                                                                                                                                                                                                                                                                                        |
| `ApplicationNotFoundError`             | Error    | Branch not found or does not belong to the specified organization                                                                                                                                                                                                                                                                       |

**Types:** `GenerationProvider`, `PendingGeneration`, `TestSuiteInfo`, `SnapshotChange`, `SnapshotChangeSummary`, `SnapshotComparison`

**Changes (command pattern):**

| Change class | Description                          |
| ------------ | ------------------------------------ |
| `AddTest`    | Adds a test case with a plan         |

### Temporal entry point (`@autonoma/test-updates/temporal`)

| Export                       | Type  | Description                                                                                       |
| ---------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `TemporalGenerationProvider` | Class | Dispatches already-started runs to the worker fleet as a batch Temporal Workflow. Only the editor's `startRuns` fires it. |

## Usage

### Starting and applying changes

```ts
import { TestSuiteUpdater, AddTest } from "@autonoma/test-updates";

// Start a new update session (creates a pending snapshot)
const updater = await TestSuiteUpdater.startUpdate({
    db,
    branchId: "branch-123",
    organizationId: "org-456", // optional - ownership check
});

await updater.apply(
    new AddTest({
        name: "Login flow",
        description: "A user with valid credentials reaches the dashboard.",
        plan: "Navigate to /login, enter credentials, click Sign In, assert dashboard is visible",
        folderId: "folder-123",
        scenarioId: "scenario-789", // optional
    }),
);
```

`continueUpdate` loads whichever snapshot is currently pending on the branch. Any caller that outlives one request - a workflow activity dispatched for a specific snapshot - must use `continueUpdateBySnapshot` instead, so it keeps operating on the exact snapshot it opened even if a newer trigger has since replaced the branch's pending pointer:

```ts
const updater = await TestSuiteUpdater.continueUpdateBySnapshot({ db, snapshotId });
```

`updater.source` names the workflow that opened the snapshot (`MANUAL` for the suite editor, otherwise the analysis pipeline), so a caller can refuse to touch a snapshot it does not own.

### Finalizing or cancelling

```ts
// Activate the snapshot. Unconditional on what did or did not run.
await updater.finalize();

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

All mutations implement the `TestSuiteChange` abstract class with a single `apply()` method, receiving the `SnapshotDraft` to mutate. This keeps the `TestSuiteUpdater` thin - it just delegates to the change object.

### Generation providers

The `GenerationProvider` interface decouples dispatching a started run from executing it:

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
