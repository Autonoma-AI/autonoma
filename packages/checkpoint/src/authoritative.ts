import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { type AnalysisFindingBucketCounts, countAnalysisFindingBuckets } from "@autonoma/types";
import type { SnapshotHealth } from "./health";
import type { AuthoritativeCheckpointInputs } from "./presentation";

// The per-snapshot authoritative data the summary layer needs, keyed by snapshot id. A snapshot appears here only
// when the merged analysis pipeline ran on it (it has an `AnalysisJob`); a legacy diffs/shadow snapshot is absent,
// so callers fall back to the legacy health-derived summary for it.
export type LoadedAuthoritativeInputs = Pick<AuthoritativeCheckpointInputs, "jobStatus" | "findingBuckets">;

/**
 * Batch-loads the authoritative-analysis inputs for a set of snapshots: each snapshot's `AnalysisJob` lifecycle
 * plus, once its `AnalysisReport` exists, the per-bucket tally of its findings. Issues a fixed two queries
 * regardless of snapshot count. Degrades to an empty map on any failure (e.g. the analysis tables are not migrated
 * in this environment) so the rail/PR list simply falls back to the legacy summary - a missing table must never
 * break the surface. Org-scoped.
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
                select: { snapshotId: true, findings: { select: { category: true } } },
            }),
        ]);

        const bucketsBySnapshot = new Map<string, AnalysisFindingBucketCounts>();
        for (const report of reports) {
            bucketsBySnapshot.set(
                report.snapshotId,
                countAnalysisFindingBuckets(report.findings.map((finding) => finding.category)),
            );
        }

        for (const job of jobs) {
            result.set(job.snapshotId, {
                jobStatus: job.status,
                findingBuckets: bucketsBySnapshot.get(job.snapshotId),
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

/**
 * The legacy `SnapshotHealth` signal for an authoritative snapshot, derived from the same verdict + finding
 * buckets as its summary, so the raw `health`/`bugCount` fields agree with the badge. A running/report-less job is
 * `running`; a client bug (or pipeline failure) is `critical`; otherwise `healthy`.
 */
export function authoritativeSnapshotHealth(inputs: LoadedAuthoritativeInputs): SnapshotHealth {
    if (inputs.jobStatus === "failed") return "critical";
    if (inputs.jobStatus === "running" || inputs.findingBuckets == null) return "running";
    return inputs.findingBuckets.bug > 0 ? "critical" : "healthy";
}
