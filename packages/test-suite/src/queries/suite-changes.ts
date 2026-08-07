import type { Prisma, PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

const logger = rootLogger.child({ name: "computeSuiteChanges" });

interface BaseSuiteChange {
    testCaseId: string;
    testCaseName: string;
    testCaseSlug: string;
    testCaseFolderId: string;
}

interface AddedSuiteChange extends BaseSuiteChange {
    type: "added";
    plan: string;
}

interface RemovedSuiteChange extends BaseSuiteChange {
    type: "removed";
    previousPlan: string;
}

interface UpdatedSuiteChange extends BaseSuiteChange {
    type: "updated";
    plan: string;
    previousPlan: string;
}

export type SuiteChange = AddedSuiteChange | RemovedSuiteChange | UpdatedSuiteChange;

const assignmentSelect = {
    testCaseId: true,
    planId: true,
    testCase: { select: { id: true, name: true, slug: true, folderId: true } },
    plan: { select: { prompt: true } },
} as const;

/**
 * The suite changes a snapshot carries relative to the snapshot it was opened from.
 *
 * Derived by diffing assignments per `testCaseId`:
 * - Present in snapshot but not source -> "added"
 * - Present in source but not snapshot -> "removed"
 * - Present in both with a different `planId` -> "updated"
 * - Same `planId` in both -> unchanged (omitted)
 *
 * A snapshot with no source snapshot reports every assignment as "added". Pure read: valid for open
 * and terminal snapshots alike, which is what lets a settlement report what a failed run discarded.
 */
export async function computeSuiteChanges(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
    prevSnapshotId: string | undefined,
): Promise<SuiteChange[]> {
    logger.info("Computing suite changes", { snapshot: { snapshotId }, extra: { prevSnapshotId } });

    if (prevSnapshotId == null) {
        const assignments = await db.testCaseAssignment.findMany({
            where: { snapshotId },
            select: assignmentSelect,
        });
        return assignments.map((assignment) => added(assignment));
    }

    const [currentAssignments, previousAssignments] = await Promise.all([
        db.testCaseAssignment.findMany({ where: { snapshotId }, select: assignmentSelect }),
        db.testCaseAssignment.findMany({ where: { snapshotId: prevSnapshotId }, select: assignmentSelect }),
    ]);

    const previousByTestCaseId = new Map(previousAssignments.map((a) => [a.testCaseId, a]));
    const currentByTestCaseId = new Map(currentAssignments.map((a) => [a.testCaseId, a]));

    const changes: SuiteChange[] = [];

    for (const [testCaseId, current] of currentByTestCaseId) {
        const previous = previousByTestCaseId.get(testCaseId);
        if (previous == null) {
            changes.push(added(current));
        } else if (current.planId !== previous.planId) {
            changes.push({
                type: "updated",
                testCaseId: current.testCase.id,
                testCaseName: current.testCase.name,
                testCaseSlug: current.testCase.slug,
                testCaseFolderId: current.testCase.folderId,
                plan: current.plan?.prompt ?? "",
                previousPlan: previous.plan?.prompt ?? "",
            });
        }
    }

    for (const [testCaseId, previous] of previousByTestCaseId) {
        if (!currentByTestCaseId.has(testCaseId)) {
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

    logger.info("Suite changes computed", { snapshot: { snapshotId }, extra: { count: changes.length } });
    return changes;
}

interface AssignmentRow {
    testCase: { id: string; name: string; slug: string; folderId: string };
    plan: { prompt: string } | null;
}

function added(assignment: AssignmentRow): AddedSuiteChange {
    return {
        type: "added",
        testCaseId: assignment.testCase.id,
        testCaseName: assignment.testCase.name,
        testCaseSlug: assignment.testCase.slug,
        testCaseFolderId: assignment.testCase.folderId,
        plan: assignment.plan?.prompt ?? "",
    };
}
