import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    type AnalysisFindingBucketCounts,
    type CheckpointExecutionState,
    coverageSummarySchema,
} from "@autonoma/types";
import type { SnapshotHealth } from "./health";
import { type AuthoritativeCheckpointInputs, buildAuthoritativeCheckpointSummary } from "./presentation";

/**
 * The health signal each execution state stands for. A `Record` over the state union, so a new execution state is a
 * compile error here until it is given one - health can never silently default to "healthy" for a state nobody
 * considered.
 */
const HEALTH_BY_EXECUTION_STATE: Record<CheckpointExecutionState, SnapshotHealth> = {
    passed: "healthy",
    failed: "critical",
    pipeline_failed: "critical",
    running: "running",
    not_started: "unknown",
    stale: "unknown",
    unknown: "unknown",
};

// The per-snapshot authoritative data the summary layer needs, keyed by snapshot id. A snapshot appears here only
// when the merged analysis pipeline ran on it (it has an `AnalysisJob`); a legacy diffs/shadow snapshot is absent,
// so callers fall back to the legacy health-derived summary for it.
export type LoadedAuthoritativeInputs = Pick<
    AuthoritativeCheckpointInputs,
    "jobStatus" | "findingBuckets" | "bugCount"
>;

/**
 * Batch-loads the authoritative-analysis inputs for a set of snapshots: each snapshot's `AnalysisJob` lifecycle
 * plus, once its `AnalysisReport` exists (i.e. the Reporter has run), the bucket counts the badge renders - read
 * straight off the report the Reporter already computed (`testCount`, `clientBugCount`, `coverage.total`) rather
 * than re-tallied from the run's findings. The report is the durable projection of the run; the findings are not
 * (a generation the run discarded takes its finding's classification with it), so a run whose classifications are
 * gone still presents its true counts. The presence of a bucket tally is the "Reporter ran" signal the health
 * derivation gates on, so a still-running run (no report yet) has `findingBuckets == null` and reads as `running`.
 *
 * Issues a fixed two queries regardless of snapshot count. Degrades to an empty map on any failure (e.g. the
 * analysis tables are not migrated in this environment) so the rail/PR list simply falls back to the legacy summary
 * - a missing table must never break the surface. Org-scoped.
 */
export async function loadAuthoritativeCheckpointInputs(
    db: PrismaClient,
    organizationId: string,
    snapshotIds: string[],
    parentLogger?: Logger,
): Promise<Map<string, LoadedAuthoritativeInputs>> {
    const logger = (parentLogger ?? rootLogger).child({ name: "loadAuthoritativeCheckpointInputs" });
    const result = new Map<string, LoadedAuthoritativeInputs>();
    if (snapshotIds.length === 0) return result;

    try {
        const [jobs, reports] = await Promise.all([
            db.analysisJob.findMany({
                where: { snapshotId: { in: snapshotIds }, organizationId },
                select: { snapshotId: true, status: true },
            }),
            db.analysisReport.findMany({
                where: { snapshotId: { in: snapshotIds }, organizationId },
                select: { snapshotId: true, clientBugCount: true, testCount: true, coverage: true },
            }),
        ]);

        const bucketsBySnapshot = new Map<string, AnalysisFindingBucketCounts>();
        const bugCountBySnapshot = new Map<string, number>();
        for (const report of reports) {
            bucketsBySnapshot.set(report.snapshotId, reportBuckets(report, logger));
            bugCountBySnapshot.set(report.snapshotId, report.clientBugCount);
        }

        for (const job of jobs) {
            result.set(job.snapshotId, {
                jobStatus: job.status,
                findingBuckets: bucketsBySnapshot.get(job.snapshotId),
                bugCount: bugCountBySnapshot.get(job.snapshotId),
            });
        }

        logger.info("Loaded authoritative checkpoint inputs", {
            extra: { snapshots: snapshotIds.length, authoritative: jobs.length },
        });
        return result;
    } catch (error) {
        logger.warn("Could not load authoritative checkpoint inputs; falling back to legacy summaries", {
            extra: { count: snapshotIds.length },
            err: error,
        });
        return new Map();
    }
}

/** The report row shape the bucket counts are read from. */
interface ReportCounts {
    snapshotId: string;
    clientBugCount: number;
    testCount: number;
    coverage: unknown;
}

/**
 * The badge's three buckets, read from what the Reporter already wrote: `coverage.total` is the coverage plane,
 * `clientBugCount` (branch-scoped open bug issues) is the red driver, and everything else in `testCount` is the
 * passed remainder. Bugs are kept out of the passed count so the metrics line ("1 bug - 4 passed") stays honest;
 * the remainder is clamped since `clientBugCount` counts branch issues, which can outnumber a single run's findings
 * when a bug is carried across snapshots.
 *
 * `coverage` is a nullable JSON blob; a row that never got one (a pre-column backfill) cannot be split into
 * passed-vs-coverage, so it is presented conservatively as all-unconfirmed ("No runs") rather than defaulting the
 * missing coverage to zero, which would read the whole run as passed. No production row is in this state.
 */
function reportBuckets(report: ReportCounts, logger: Logger): AnalysisFindingBucketCounts {
    const parsed = coverageSummarySchema.safeParse(report.coverage);
    if (!parsed.success) {
        logger.warn("Analysis report has no usable coverage summary; presenting it as unconfirmed", {
            snapshot: { snapshotId: report.snapshotId },
        });
        return { bug: report.clientBugCount, passed: 0, coverage: Math.max(report.testCount, 0) };
    }
    const coverage = parsed.data.total;
    const passed = Math.max(report.testCount - coverage - report.clientBugCount, 0);
    return { bug: report.clientBugCount, passed, coverage };
}

/**
 * The legacy `SnapshotHealth` signal for an authoritative snapshot, read off the execution state its own summary
 * derived, so the raw `health` field cannot disagree with the badge rendered beside it. `not_started` - a run that
 * confirmed nothing, or selected nothing - is `unknown` rather than `healthy`: surfaces that gate on
 * `health === "healthy"` are claiming the app was checked, and it was not.
 */
export function authoritativeSnapshotHealth(inputs: LoadedAuthoritativeInputs): SnapshotHealth {
    return HEALTH_BY_EXECUTION_STATE[buildAuthoritativeCheckpointSummary(inputs).executionState];
}
