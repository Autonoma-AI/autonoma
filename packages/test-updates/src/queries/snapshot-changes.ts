import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

interface BaseChange {
    testCaseId: string;
    testCaseName: string;
    testCaseSlug: string;
    testCaseFolderId: string | null;
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

function toSummary(changes: SnapshotChange[]): SnapshotChangeSummary {
    return {
        added: changes.filter((c) => c.type === "added").length,
        removed: changes.filter((c) => c.type === "removed").length,
        updated: changes.filter((c) => c.type === "updated").length,
    };
}
