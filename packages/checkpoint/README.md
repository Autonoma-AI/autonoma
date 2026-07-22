# @autonoma/checkpoint

The single source of truth for **checkpoint / PR test metrics**: how a snapshot's
test-case assignments, runs, generations, and refinement loop roll up into the
counts, engine-vs-app failing attribution, open-bug count, execution state, and the
human-readable label/reason shown to users.

Every surface that reports these numbers consumes this package so they can never
disagree:

- the API (`apps/api`) - PR list, PR detail, snapshot report (over tRPC as `summary`)
- the GitHub PR commenter (`apps/jobs/run-completion-notification`)

## Entry point

```ts
import { getCheckpointSummaries } from "@autonoma/checkpoint";

const summaries = await getCheckpointSummaries(db, [{ id: snapshotId, status }], logger);
const summary = summaries.get(snapshotId); // CheckpointPresentationSummary | undefined
```

`getCheckpointSummaries` runs health aggregation + open-bug counting (a fixed
number of `IN`-scoped queries regardless of batch size) and feeds the result
through `buildCheckpointSummary`. The returned `CheckpointPresentationSummary`
(defined in `@autonoma/types`) carries `tone`, `label`, `reason`,
`executionState`, `testCounts`, `failingByKind`, `openBugCount`, and
`issueOccurrenceCount`.

### Authoritative (merged-analysis) snapshots

A snapshot the merged analysis pipeline ran has an `AnalysisJob` and files **no**
`Bug` rows - its findings live on `AnalysisReport`/`AnalysisFinding` - so the legacy
health/Bug model is empty for it. For those, callers first
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
| `executed-tests.ts` | `listExecutedTestsForSnapshot(s)` and outcome classification (`finalOutcomeFor*`). |
| `refinement-outcomes.ts` | `computeIterationOutcomes` - pure refinement-loop outcome resolution. No DB. |
| `open-bugs.ts` | `countOpenBugsBySnapshot` - unique open bugs per snapshot. |
| `index.ts` | `getCheckpointSummaries` + re-exports of the building blocks. |

## Commands

```bash
pnpm --filter @autonoma/checkpoint typecheck
pnpm --filter @autonoma/checkpoint test   # Testcontainers + real Postgres
```
