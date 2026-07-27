import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

interface BaseChange {
    testCaseId: string;
    testCaseName: string;
    testCaseSlug: string;
    testCaseFolderId: string;
}

interface AddedChange extends BaseChange {
    type: "added";
    plan: string;
}

interface RemovedChange extends BaseChange {
    type: "removed";
    previousPlan: string;
}

interface UpdatedChange extends BaseChange {
    type: "updated";
    plan: string;
    previousPlan: string;
}

export type SnapshotChange = AddedChange | RemovedChange | UpdatedChange;

const assignmentSelect = {
    testCaseId: true,
    planId: true,
    testCase: { select: { id: true, name: true, slug: true, folderId: true } },
    plan: { select: { prompt: true } },
} as const;

/** Plan id per test case for one snapshot; a key with a `null` value is an assignment with no plan. */
type PlanIdsByTestCaseId = ReadonlyMap<string, string | null>;

const NO_ASSIGNMENTS: PlanIdsByTestCaseId = new Map();

/**
 * Computes the list of test-case changes for a snapshot relative to a comparison snapshot.
 *
 * Present in snapshot but not comparison -> "added"
 * Present in comparison but not snapshot -> "removed"
 * Present in both but planId differs     -> "updated"
 * Same planId in both                    -> unchanged (omitted)
 */
export async function computeSnapshotChanges(
    db: PrismaClient,
    snapshotId: string,
    prevSnapshotId: string,
    parentLogger?: Logger,
): Promise<SnapshotChange[]> {
    const logger = (parentLogger ?? rootLogger).child({ name: "computeSnapshotChanges", snapshotId, prevSnapshotId });
    logger.info("Computing snapshot changes");

    const [pendingAssignments, previousAssignments] = await Promise.all([
        db.testCaseAssignment.findMany({ where: { snapshotId }, select: assignmentSelect }),
        db.testCaseAssignment.findMany({ where: { snapshotId: prevSnapshotId }, select: assignmentSelect }),
    ]);

    const previousByTestCaseId = new Map(previousAssignments.map((a) => [a.testCaseId, a]));
    const pendingByTestCaseId = new Map(pendingAssignments.map((a) => [a.testCaseId, a]));

    const changes: SnapshotChange[] = [];

    for (const [testCaseId, pending] of pendingByTestCaseId) {
        const previous = previousByTestCaseId.get(testCaseId);

        if (previous == null) {
            changes.push({
                type: "added",
                testCaseId: pending.testCase.id,
                testCaseName: pending.testCase.name,
                testCaseSlug: pending.testCase.slug,
                testCaseFolderId: pending.testCase.folderId,
                plan: pending.plan?.prompt ?? "",
            });
        } else if (pending.planId !== previous.planId) {
            changes.push({
                type: "updated",
                testCaseId: pending.testCase.id,
                testCaseName: pending.testCase.name,
                testCaseSlug: pending.testCase.slug,
                testCaseFolderId: pending.testCase.folderId,
                plan: pending.plan?.prompt ?? "",
                previousPlan: previous.plan?.prompt ?? "",
            });
        }
    }

    for (const [testCaseId, previous] of previousByTestCaseId) {
        if (!pendingByTestCaseId.has(testCaseId)) {
            changes.push({
                type: "removed",
                testCaseId: previous.testCase.id,
                testCaseName: previous.testCase.name,
                testCaseSlug: previous.testCase.slug,
                testCaseFolderId: previous.testCase.folderId,
                previousPlan: previous.plan?.prompt ?? "",
            });
        }
    }

    logger.info("Changes computed", { count: changes.length });

    return changes;
}

export interface SnapshotChangeSummary {
    added: number;
    removed: number;
    updated: number;
}

/** Returns counts of added/removed/updated test cases for the given snapshot. */
export async function summarizeSnapshotChanges(
    db: PrismaClient,
    snapshotId: string,
    prevSnapshotId: string,
    parentLogger?: Logger,
): Promise<SnapshotChangeSummary> {
    const changes = await computeSnapshotChanges(db, snapshotId, prevSnapshotId, parentLogger);
    return toSummary(changes);
}

/**
 * Like `computeSnapshotChanges` but handles a null `prevSnapshotId` by treating
 * every assignment in the snapshot as "added". Use this at call sites where the
 * previous snapshot may not exist (e.g. the first snapshot on a branch).
 */
export async function getChangesForSnapshot(
    db: PrismaClient,
    snapshotId: string,
    prevSnapshotId: string | null,
    parentLogger?: Logger,
): Promise<SnapshotChange[]> {
    if (prevSnapshotId == null) {
        const logger = (parentLogger ?? rootLogger).child({ name: "getChangesForSnapshot", snapshotId });
        logger.info("No previous snapshot, treating all assignments as added");
        const assignments = await db.testCaseAssignment.findMany({
            where: { snapshotId },
            select: {
                testCase: { select: { id: true, name: true, slug: true, folderId: true } },
                plan: { select: { prompt: true } },
            },
        });
        return assignments.map((a) => ({
            type: "added" as const,
            testCaseId: a.testCase.id,
            testCaseName: a.testCase.name,
            testCaseSlug: a.testCase.slug,
            testCaseFolderId: a.testCase.folderId,
            plan: a.plan?.prompt ?? "",
        }));
    }
    return computeSnapshotChanges(db, snapshotId, prevSnapshotId, parentLogger);
}

/** Summarizing variant of `getChangesForSnapshot`. */
export async function summarizeChangesForSnapshot(
    db: PrismaClient,
    snapshotId: string,
    prevSnapshotId: string | null,
    parentLogger?: Logger,
): Promise<SnapshotChangeSummary> {
    const changes = await getChangesForSnapshot(db, snapshotId, prevSnapshotId, parentLogger);
    return toSummary(changes);
}

/** A snapshot and the snapshot its changes are measured against. */
export interface SnapshotComparison {
    snapshotId: string;
    prevSnapshotId: string | null;
}

/**
 * Batched variant of `summarizeChangesForSnapshot`, keyed by snapshot id.
 *
 * Counting added/removed/updated only needs each assignment's `(testCaseId, planId)`, so this
 * reads those columns for every snapshot in one query instead of fanning the full change list -
 * which loads each test case and its natural-language plan text - out per snapshot.
 */
export async function summarizeChangesForSnapshots(
    db: PrismaClient,
    comparisons: readonly SnapshotComparison[],
    parentLogger?: Logger,
): Promise<Map<string, SnapshotChangeSummary>> {
    const logger = (parentLogger ?? rootLogger).child({ name: "summarizeChangesForSnapshots" });
    logger.info("Summarizing snapshot changes", { extra: { comparisonCount: comparisons.length } });

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

    const assignmentsBySnapshotId = new Map<string, Map<string, string | null>>();
    for (const assignment of assignments) {
        const bySnapshot = assignmentsBySnapshotId.get(assignment.snapshotId) ?? new Map<string, string | null>();
        bySnapshot.set(assignment.testCaseId, assignment.planId);
        assignmentsBySnapshotId.set(assignment.snapshotId, bySnapshot);
    }

    const summaries = new Map<string, SnapshotChangeSummary>();
    for (const comparison of comparisons) {
        summaries.set(comparison.snapshotId, summarizeComparison(comparison, assignmentsBySnapshotId));
    }

    logger.info("Snapshot changes summarized", { extra: { snapshotCount: summaries.size } });

    return summaries;
}

function summarizeComparison(
    { snapshotId, prevSnapshotId }: SnapshotComparison,
    assignmentsBySnapshotId: ReadonlyMap<string, PlanIdsByTestCaseId>,
): SnapshotChangeSummary {
    const pending = assignmentsBySnapshotId.get(snapshotId) ?? NO_ASSIGNMENTS;

    // No previous snapshot means every assignment is new, matching `getChangesForSnapshot`.
    if (prevSnapshotId == null) return { added: pending.size, removed: 0, updated: 0 };

    const previous = assignmentsBySnapshotId.get(prevSnapshotId) ?? NO_ASSIGNMENTS;

    let added = 0;
    let removed = 0;
    let updated = 0;

    for (const [testCaseId, planId] of pending) {
        if (!previous.has(testCaseId)) added += 1;
        else if (previous.get(testCaseId) !== planId) updated += 1;
    }

    for (const testCaseId of previous.keys()) {
        if (!pending.has(testCaseId)) removed += 1;
    }

    return { added, removed, updated };
}

function toSummary(changes: SnapshotChange[]): SnapshotChangeSummary {
    return {
        added: changes.filter((c) => c.type === "added").length,
        removed: changes.filter((c) => c.type === "removed").length,
        updated: changes.filter((c) => c.type === "updated").length,
    };
}
