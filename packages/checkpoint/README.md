# @autonoma/checkpoint

The building blocks for **checkpoint / PR test metrics**: how a snapshot's test-case
assignments, runs, and generations roll up into the counts, execution state, and the
human-readable label/reason shown to users.

Every surface that reports these numbers composes them from here, so they cannot
disagree. The API (`apps/api`) is the only consumer today - PR list, PR detail, and
the snapshot report, all over tRPC as `summary`.

## Composing a summary

There is deliberately no single entry point: the legacy and authoritative paths load
different inputs, so each caller loads what its snapshot has and builds from that.

```ts
import { aggregateSnapshotHealth, buildCheckpointSummary } from "@autonoma/checkpoint";

const health = (await aggregateSnapshotHealth(db, [{ id: snapshotId, status }], logger)).get(snapshotId);
const summary = health && buildCheckpointSummary({ snapshotStatus: status, counts: health.counts });
```

`aggregateSnapshotHealth` issues a fixed number of `IN`-scoped queries regardless of
batch size. The returned `CheckpointPresentationSummary` (defined in `@autonoma/types`)
carries `tone`, `label`, `reason`, `executionState`, `testCounts`, and `suiteChangeCount`.

The legacy summary states no bug count. The store it read is gone, so a bug count lives
only on the `analysis` block below - one copy, authored by the Reporter.

### Authoritative (merged-analysis) snapshots

A snapshot the merged analysis pipeline ran has an `AnalysisJob`, and its findings
live on `AnalysisReport`/`AnalysisFinding` rather than in the legacy health model.
For those, callers first
`loadAuthoritativeCheckpointInputs(db, orgId, snapshotIds)` (a bulk two-query load
that degrades to an empty map when the analysis tables are absent) and pass the
result to `buildAuthoritativeCheckpointSummary`, which derives `tone`/`label`/`reason`
from the verdict + finding-category buckets (client bug -> "N bugs" critical, else
"Passing"; running -> "Analyzing"; failed job -> pipeline failure). The summary also
carries an `analysis` block (`jobStatus`, `bugCount`, `passedCount`, `coverageCount`)
so the metrics line renders authoritative vocabulary. A non-authoritative snapshot is
absent from the loaded map and stays on the legacy path unchanged.

## Modules

| File | Responsibility |
|---|---|
| `presentation.ts` | `buildCheckpointSummary` (legacy) + `buildAuthoritativeCheckpointSummary` - pure counts -> presentation summary. No DB. |
| `authoritative.ts` | `loadAuthoritativeCheckpointInputs` (AnalysisJob + AnalysisReport findings, org-scoped) and `authoritativeSnapshotHealth`. |
| `health.ts` | `aggregateSnapshotHealth`, `computeSnapshotHealth`, `tallyExecutedTests`, `SnapshotHealthCounts`. |
| `executed-tests.ts` | `listExecutedTestsForSnapshot(s)` and outcome classification from the engine's own generation status. |
| `index.ts` | Re-exports of the building blocks. |

## Commands

```bash
pnpm --filter @autonoma/checkpoint typecheck
pnpm --filter @autonoma/checkpoint test   # pure unit tests - no database
```
