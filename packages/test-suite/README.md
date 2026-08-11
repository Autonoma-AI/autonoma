# @autonoma/test-suite

The suite module: the data-access layer for a branch's test suite lineage. Its aggregate is the line of immutable
snapshots a branch's suite evolves through - the single open snapshot being written, the branch's three pointers
(`activeSnapshotId`, `pendingSnapshotId`, `baseSnapshotId`), and the runs. It writes `test_case`, `test_plan`,
`test_case_assignment`, `branch_snapshot`, `branch` and `test_generation`, and nothing else: an `analysis_*` table is
the analysis store's aggregate, and the scenario rows a fork carries along are `@autonoma/scenario`'s
(`forkScenarioDataForSnapshot`, called from `openSnapshot`).

## Vocabulary

| Word              | Means                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| **Snapshot**      | One version of a branch's test suite. Immutable once terminal.                            |
| **Open snapshot** | A snapshot in `processing`, and the handle on it. The only thing that can be written.     |
| **Run**           | One execution of a plan (`TestGeneration`). Started explicitly; never created by an edit. |
| **Suite**         | The tests a snapshot assigns, each with its pinned plan.                                  |
| **Edit snapshot** | An open snapshot the manual editor owns (`MANUAL`) rather than an analysis run.           |

## Exports

| Export           | Type  | Description                                                                                        |
| ---------------- | ----- | -------------------------------------------------------------------------------------------------- |
| `TestSuiteStore` | Class | Entry point. `openSnapshot` / `openEditSnapshot` / `reopen` / `read` / `readAssignments` / `latestRunPerTest` / `changesSince` / `changesAgainst` / `summarizeChanges` / `resolveSource`. |
| `OpenSnapshot`   | Class | The handle on one open snapshot: suite edits, `startRun`, `withTransaction`, and the terminals.     |
| `deriveForkPointSnapshotId` | Function | The one rule turning a branch's pointers into the snapshot its suite diverged from. |

Errors: `BranchNotFoundError`, `BranchAlreadyOpenError` (carries `pendingSnapshotId` for supersede orchestration),
`SnapshotNotFoundError`, `SnapshotNotOpenError` (carries the actual status), `NoSnapshotBaseError`,
`TestNotAssignedError`, `TestPlanMissingError`.

Types: `Suite`, `SuiteAssignment`, `SuiteRun`, `SuiteChange`, `SuiteChangeSummary`, `SnapshotComparison`,
`SnapshotSource`, `ResolvedSnapshotSource`, `BranchForkPoint`. Constant: `EDIT_SNAPSHOT_TRIGGER`, the trigger an
edit session's snapshot carries.

## The contract

```ts
const store = new TestSuiteStore(db);

// The one deriving site for "what would a new snapshot fork from". The API trigger asks it for
// `alreadyAnalyzed`; the run's open asks it for the source - so the two cannot disagree.
const resolved = await store.resolveSource({ branchId, headSha, fallbackBaseSha });

// A snapshot's source is an explicit input. When the source is the branch's own snapshot, `baseSha`
// is derived from its head, so the pair cannot diverge. A foreign source (a new PR branch inheriting
// main's suite) contributes only the suite: the diff base stays the caller's, because the inherited
// snapshot's head can lag the real fork point when merges to main are not analyzed.
const open = await store.openSnapshot({ branchId, headSha, source: resolved.source, trigger: "WEBHOOK" });

// A manual edit changes the suite, not the commit: it always forks the branch's active snapshot and
// inherits its head as both head and base, so the next analysis still diffs from where the branch was.
const editing = await store.openEditSnapshot({ branchId, organizationId });

// Plain suite edits. None of them starts a run.
const { testCaseId, planId, slug } = await open.addTest({ name, description, plan, folderId });
await open.adoptTest({ testCaseId, plan });      // merge-import: an existing TestCase joins this suite
await open.revisePlan({ testCaseId, plan });     // mint a new plan record and repoint (plans are immutable)
await open.restorePlan({ testCaseId, planId });  // undo a revise without minting (reads as unchanged)
await open.dropTest(testCaseId);                 // membership is the assignment; the TestCase survives
await open.discardTest(testCaseId);              // back to what the source snapshot held

// The only way a run begins. Resolves the pinned plan at this moment and returns the scenario it
// carries, so the caller can provision before executing.
const { runId, scenarioId } = await open.startRun(testCaseId);

// Where each of the snapshot's tests stands: its most recent run, for every test one was started for.
const runs = await store.latestRunPerTest(open.snapshotId);

// What a snapshot changed. `changesSince` measures against what it was opened from; `changesAgainst`
// against a snapshot you name (a PR view compares the active snapshot to the branch's fork point).
// `summarizeChanges` is the counts-only read for a whole history list - one query, not one per row.
const changes = await store.changesSince(snapshotId);
const sincePrFork = await store.changesAgainst(activeSnapshotId, forkPointSnapshotId);
const counts = await store.summarizeChanges([{ snapshotId, prevSnapshotId }]);

// Terminals. Exactly one wins, and each IS the compare-and-swap: `false` means another actor
// settled this snapshot first. Promotion is unconditional on what did or did not run.
const won = await open.promote();
await open.fail(reason);    // marks the runs the outcome cut short; keeps every row
await open.cancel(reason);  // ditto - how a superseded run is closed out
```

Every mutation asserts the snapshot is still open inside its own transaction (a share lock on the snapshot row that
a concurrent terminal must wait for), so terminal snapshots are immutable by construction - a stale handle cannot
write through a settled snapshot.

### What lives here, and what does not

The module answers questions about suite data and guards the open-snapshot invariants. It does not know why a caller
is asking. So `readAssignments` ("what do these snapshots assign") lives here, while shaping those rows into merge
classifier input lives in `@autonoma/diffs` next to the classifier whose contract it satisfies
(`buildMergeClassifierRows`), and pinning a merged PR to its source snapshot lives in the diffs worker beside the
merge flow (`pinMergeSource`) - that one is a GitHub question, not a lineage one. What the two share is the lineage
rule itself, `deriveForkPointSnapshotId`, exported from here so the merge flow and the PR diff view cannot drift.

## Testing

```bash
pnpm --filter @autonoma/test-suite test
```

Integration tests with Testcontainers (real PostgreSQL) via `@autonoma/integration-test`; see `test/`.
