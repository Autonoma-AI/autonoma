import type { Prisma, PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { classifyAssignmentChanges } from "./classify-assignment-changes";

const logger = rootLogger.child({ name: "summarizeSuiteChanges" });

/** How many tests a snapshot added, removed and updated relative to the snapshot it was opened from. */
export interface SuiteChangeSummary {
    added: number;
    removed: number;
    updated: number;
}

/** A snapshot and the snapshot its changes are measured against. */
export interface SnapshotComparison {
    snapshotId: string;
    prevSnapshotId?: string;
}

/** All a count needs off an assignment: the plan id the rule compares. Membership comes from the map key. */
interface PlanIdRow {
    planId: string | null;
}

const NO_ASSIGNMENTS: ReadonlyMap<string, PlanIdRow> = new Map();

/**
 * The counts {@link computeSuiteChanges} would produce, for many snapshots at once, keyed by snapshot id.
 *
 * Counting added/removed/updated only needs each assignment's `(testCaseId, planId)`, so this reads those columns
 * for every snapshot in one query. Prefer it over `computeSuiteChanges` per snapshot, which builds the full change
 * list - loading every assignment's test case and plan prose - to produce three integers.
 *
 * The two agree by construction: both classify through {@link classifyAssignmentChanges}, and only what they load
 * and how they present the answer differs.
 */
export async function summarizeSuiteChanges(
    db: PrismaClient | Prisma.TransactionClient,
    comparisons: readonly SnapshotComparison[],
): Promise<Map<string, SuiteChangeSummary>> {
    logger.info("Summarizing suite changes", { extra: { comparisonCount: comparisons.length } });

    if (comparisons.length === 0) return new Map();

    // Both sides of every comparison in one read. A `prevSnapshotId` is not necessarily itself
    // among the compared snapshots - callers hide cancelled snapshots and investigation twins from
    // history, but either can still be some visible snapshot's predecessor.
    const snapshotIds = new Set<string>();
    for (const comparison of comparisons) {
        snapshotIds.add(comparison.snapshotId);
        if (comparison.prevSnapshotId != null) snapshotIds.add(comparison.prevSnapshotId);
    }

    const assignments = await db.testCaseAssignment.findMany({
        where: { snapshotId: { in: [...snapshotIds] } },
        select: { snapshotId: true, testCaseId: true, planId: true },
    });

    const assignmentsBySnapshotId = new Map<string, Map<string, PlanIdRow>>();
    for (const assignment of assignments) {
        const bySnapshot = assignmentsBySnapshotId.get(assignment.snapshotId) ?? new Map<string, PlanIdRow>();
        bySnapshot.set(assignment.testCaseId, assignment);
        assignmentsBySnapshotId.set(assignment.snapshotId, bySnapshot);
    }

    const summaries = new Map<string, SuiteChangeSummary>();
    for (const comparison of comparisons) {
        summaries.set(comparison.snapshotId, summarizeComparison(comparison, assignmentsBySnapshotId));
    }

    logger.info("Suite changes summarized", { extra: { snapshotCount: summaries.size } });

    return summaries;
}

function summarizeComparison(
    { snapshotId, prevSnapshotId }: SnapshotComparison,
    assignmentsBySnapshotId: ReadonlyMap<string, ReadonlyMap<string, PlanIdRow>>,
): SuiteChangeSummary {
    const current = assignmentsBySnapshotId.get(snapshotId) ?? NO_ASSIGNMENTS;
    // A named predecessor holding no assignments is still a predecessor; only an absent one means
    // the snapshot was opened from nothing.
    const previous =
        prevSnapshotId == null ? undefined : (assignmentsBySnapshotId.get(prevSnapshotId) ?? NO_ASSIGNMENTS);

    const summary: SuiteChangeSummary = { added: 0, removed: 0, updated: 0 };
    for (const entry of classifyAssignmentChanges(current, previous)) {
        summary[entry.type] += 1;
    }
    return summary;
}
