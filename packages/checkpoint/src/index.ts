import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import type { CheckpointPresentationSummary } from "@autonoma/types";
import { aggregateSnapshotHealth } from "./health";
import { countOpenBugsBySnapshot } from "./open-bugs";
import { buildCheckpointSummary } from "./presentation";

export interface CheckpointSummaryInput {
    id: string;
    status: string;
    // Optional extras the list/report paths know but the commenter usually does not.
    issueOccurrenceCount?: number;
    suiteChangeCount?: number;
}

/**
 * The single high-level entry point for checkpoint presentation summaries.
 *
 * Both the API (PR list, snapshot report) and the GitHub PR commenter call this
 * so every surface derives identical counts, engine-vs-app failure attribution,
 * open-bug count, execution state, and label/reason from one place. Issues a fixed number of
 * `IN`-scoped queries (health aggregation + open-bug counting) regardless of how
 * many snapshots are passed.
 */
export async function getCheckpointSummaries(
    db: PrismaClient,
    snapshots: CheckpointSummaryInput[],
    logger?: Logger,
): Promise<Map<string, CheckpointPresentationSummary>> {
    if (snapshots.length === 0) return new Map();

    const snapshotIds = snapshots.map((s) => s.id);
    const [healthBySnapshot, openBugCountBySnapshot] = await Promise.all([
        aggregateSnapshotHealth(
            db,
            snapshots.map((s) => ({ id: s.id, status: s.status })),
            logger,
        ),
        countOpenBugsBySnapshot(db, snapshotIds),
    ]);

    const summaries = new Map<string, CheckpointPresentationSummary>();
    for (const snapshot of snapshots) {
        const health = healthBySnapshot.get(snapshot.id);
        if (health == null) continue;
        summaries.set(
            snapshot.id,
            buildCheckpointSummary({
                snapshotStatus: snapshot.status,
                counts: health.counts,
                openBugCount: openBugCountBySnapshot.get(snapshot.id) ?? 0,
                issueOccurrenceCount: snapshot.issueOccurrenceCount,
                failingByKind: health.failingByKind,
                suiteChangeCount: snapshot.suiteChangeCount,
            }),
        );
    }
    return summaries;
}

export {
    aggregateSnapshotHealth,
    computeSnapshotHealth,
    computeFailingByKind,
    failingExecutionIds,
    loadIssueKindsForExecutions,
    tallyExecutedTests,
    type ExecutedTestTally,
    type FailingByKind,
    type IssueKindsByExecution,
    type SnapshotHealth,
    type SnapshotHealthCounts,
    type SnapshotHealthResult,
} from "./health";
export { countOpenBugsBySnapshot } from "./open-bugs";
export {
    buildCheckpointSummary,
    buildAuthoritativeCheckpointSummary,
    type AuthoritativeAnalysisJobStatus,
    type AuthoritativeCheckpointInputs,
    type BuildCheckpointSummaryInputs,
} from "./presentation";
export {
    authoritativeSnapshotHealth,
    loadAuthoritativeCheckpointInputs,
    type LoadedAuthoritativeInputs,
} from "./authoritative";
export {
    statsFromSummary,
    isNoTestsAffected,
    healthyHeadlineFromSummary,
    type CommentTestStats,
} from "./summary-to-comment";
export {
    listExecutedTestsForSnapshot,
    listExecutedTestsForSnapshots,
    finalOutcomeForGenerationStatus,
    type SnapshotExecutedTest,
    type SnapshotExecutedTestFinalOutcome,
} from "./executed-tests";
export {
    computeIterationOutcomes,
    type RefinementIterationOutcomes,
    type RefinementGenerationRow,
    type TestCaseLite,
    type OutcomeValidated,
    type OutcomeFailedAtGeneration,
    type OutcomeAwaiting,
} from "./refinement-outcomes";
