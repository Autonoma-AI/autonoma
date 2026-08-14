import type { AnalysisJobStatus, Prisma, PrismaClient } from "@autonoma/db";
import type { RunPlaneSummary } from "@autonoma/types";
import { EMPTY_PLANE_SUMMARY, readPlaneSummaries } from "./finding-coverage";

/**
 * One analysis's lifecycle, off its `AnalysisJob` row. Presence IS the authoritative predicate: a snapshot with
 * a lifecycle was analyzed by the merged pipeline (running or settled); one without is a legacy/manual snapshot.
 */
export interface AnalysisLifecycle {
    snapshotId: string;
    status: AnalysisJobStatus;
    failureReason?: string;
    startedAt?: Date;
    completedAt?: Date;
    /** The Impact Analysis stage's selection reasoning; absent while it is still running or when it produced none. */
    impactReasoning?: string;
}

export interface AnalysisLifecycleSummary extends AnalysisLifecycle {
    /**
     * What the run found, present only once its Reporter settled - so its presence is the "settled" predicate and
     * its absence means still running, or failed before settling. Counted from the run's findings.
     */
    report?: RunPlaneSummary;
}

export const lifecycleSelect = {
    snapshotId: true,
    status: true,
    failureReason: true,
    startedAt: true,
    completedAt: true,
    impactReasoning: true,
} satisfies Prisma.AnalysisJobSelect;

export type LifecycleRow = Prisma.AnalysisJobGetPayload<{ select: typeof lifecycleSelect }>;

export function toLifecycle(row: LifecycleRow): AnalysisLifecycle {
    return {
        snapshotId: row.snapshotId,
        status: row.status,
        failureReason: row.failureReason ?? undefined,
        startedAt: row.startedAt ?? undefined,
        completedAt: row.completedAt ?? undefined,
        impactReasoning: row.impactReasoning ?? undefined,
    };
}

/** One analysis's lifecycle, or undefined for a snapshot the pipeline never analyzed. */
export async function readLifecycle(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<AnalysisLifecycle | undefined> {
    const job = await db.analysisJob.findUnique({ where: { snapshotId }, select: lifecycleSelect });
    return job == null ? undefined : toLifecycle(job);
}

/**
 * Batch: the lifecycles (with each settled run's counts) of many snapshots at once, keyed by snapshot id - a fixed
 * three queries regardless of count. A snapshot absent from the map was never analyzed by the pipeline; a present
 * one with no `report` is still running or failed before settling. Org-scoped: a snapshot outside the organization
 * is simply absent.
 */
export async function readLifecycles(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotIds: string[],
    organizationId: string,
): Promise<Map<string, AnalysisLifecycleSummary>> {
    const result = new Map<string, AnalysisLifecycleSummary>();
    if (snapshotIds.length === 0) return result;

    const [jobs, settled, planeSummaries] = await Promise.all([
        db.analysisJob.findMany({
            where: { snapshotId: { in: snapshotIds }, organizationId },
            select: lifecycleSelect,
        }),
        db.analysisReport.findMany({
            where: { snapshotId: { in: snapshotIds }, organizationId },
            select: { snapshotId: true },
        }),
        readPlaneSummaries(db, snapshotIds),
    ]);

    const settledSnapshots = new Set(settled.map((report) => report.snapshotId));
    for (const job of jobs) {
        const lifecycle = toLifecycle(job);
        // A settled run that judged nothing still settled; only an unsettled one has no counts to report.
        const report = settledSnapshots.has(job.snapshotId)
            ? (planeSummaries.get(job.snapshotId) ?? EMPTY_PLANE_SUMMARY)
            : undefined;
        result.set(job.snapshotId, { ...lifecycle, report });
    }
    return result;
}
