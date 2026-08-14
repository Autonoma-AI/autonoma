# @autonoma/analysis

The analysis module: the data-access layer for the merged analysis pipeline's own tables. Its aggregate is a
branch's **issue ledger**, with one **analysis** (one pass of the pipeline over one snapshot, 1:1 with it) as a
scope inside it - `AnalysisIssue` is branch-scoped but its only writer is always an analysis, so the durable thing
the module owns is the ledger and an analysis is an episode that appends findings and reconciles it.

It writes `analysis_job`, `analysis_finding`, `analysis_classification`, `analysis_issue`, `analysis_issue_version`
and `analysis_report`, and never touches an assignment (the suite is `@autonoma/test-suite`'s aggregate; the two
write sets are disjoint).

## Interface

```ts
const store = new AnalysisStore(db);

// The lifecycle row, composed into the suite store's snapshot-open transaction:
await suiteStore.openSnapshot({
    ...,
    onOpened: (tx, identity) =>
        store.open({ snapshotId: identity.snapshotId, organizationId: identity.organizationId }, tx),
});

// One analysis (addressed by snapshot id, never "whatever is pending"):
const analysis = store.forAnalysis(snapshotId);
await analysis.recordClassification({ testCaseId, number, generationId, category, headline, report });
await analysis.recordContainment({ testCaseId, failure: { kind: "investigator_crashed", message } });
const findings = await analysis.findings();   // incl. each finding's attributed branch issue
const report = await analysis.report();       // the settled header (verdict, counts, summary, coverage)
const ledger = await analysis.branch();       // the ledger of the branch this analysis runs on
const result = await analysis.settleReport({ content, issues }); // atomic; discards when superseded
const won = await analysis.close(outcome);                       // the AnalysisJob's compare-and-swap

// The branch's ledger (the one place its branch-scoped facts are read):
const ledger = store.forBranch(branchId);
await ledger.openIssues({ kind: "bug" });
await ledger.openBugCount();
await ledger.coveredTestsForOpenBugs();
await ledger.priorReports({ excludeSnapshotId, limit });

// A test's verdict history across the application's analyses (the classifier's baseline evidence):
await store.priorRuns({ applicationId, testSlug, currentSnapshotId });
```

## Invariants the module holds

- **A finding is an investigation**: at most two runs, each with exactly one classification
  (`AnalysisClassification.generationId` is required). An investigation that crashed without judging a run records
  a structured `failure` on the finding and has **no** classification - "contained" is derived from that emptiness,
  never stored as a fake classification, so `number` has no sentinel slots and no gaps.
- **Issue content is append-only**: `AnalysisIssue` holds only identity + lifecycle (`resolvedAt`); every authored
  restatement (title, severity, expected/actual behavior, narrative, evidence, primary screenshot/test, suspected
  cause) is an immutable `AnalysisIssueVersion`, with `currentVersion` pointing at the newest - the same shape as
  `AnalysisFinding` → `AnalysisClassification`. An `open`/`carry_forward` mints a version and re-points; a `resolve`
  mints none. So a carry-forward **appends** a restatement rather than overwriting the prior narrative/severity/cause
  in place, and "what did this issue say last week" stays answerable. Readers resolve content through `currentVersion`.
- **`settleReport` is atomic**: the issue reconciliations, the finding attributions and the report row commit
  together, so a run's verdict and its issues can never disagree.
- **Branch-scoped writes assert liveness inside the transaction that writes**: `settleReport` takes an exclusive
  lock on the snapshot row and discards (rather than throws) when the snapshot is no longer `processing` - a Reporter
  that finishes after a newer push superseded its run must not resolve or open issues on evidence from a head the
  PR no longer contains. Per-snapshot findings are inert after settlement and deliberately not gated.
- **`settleReport` is idempotent**: the report row is born exactly once and its existence proves a prior
  settlement committed, so a retry reports `already_settled` instead of duplicating every opened issue.
- **A resolve keeps its justification**: the resolving finding and the Reporter's note are persisted
  (`resolvedByFindingId`, `resolutionNote`), so which passing test closed an issue stays auditable.
- **Every queued test is covered**: settlement refuses to write a report while a test that queued a run has
  neither a verdict nor a recorded containment.

## Testing

Integration tests with Testcontainers (one shared Postgres, per-harness database). `pnpm test --filter
@autonoma/analysis`.
