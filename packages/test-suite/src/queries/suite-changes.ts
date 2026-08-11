import type { Prisma, PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { type AssignmentDiffEntry, classifyAssignmentChanges } from "./classify-assignment-changes";

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
 * The suite changes a snapshot carries relative to the snapshot it was opened from, each with the
 * plan prose behind it. What changed is {@link classifyAssignmentChanges}'s call; this read only
 * loads the rows and dresses the answer.
 *
 * Pure read: valid for open and terminal snapshots alike, which is what lets a settlement report
 * what a failed run discarded.
 */
export async function computeSuiteChanges(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
    prevSnapshotId: string | undefined,
): Promise<SuiteChange[]> {
    logger.info("Computing suite changes", { snapshot: { snapshotId }, extra: { prevSnapshotId } });

    const [currentAssignments, previousAssignments] = await Promise.all([
        db.testCaseAssignment.findMany({ where: { snapshotId }, select: assignmentSelect }),
        prevSnapshotId == null
            ? undefined
            : db.testCaseAssignment.findMany({ where: { snapshotId: prevSnapshotId }, select: assignmentSelect }),
    ]);

    const changes = classifyAssignmentChanges(
        byTestCaseId(currentAssignments),
        previousAssignments == null ? undefined : byTestCaseId(previousAssignments),
    ).map(toSuiteChange);

    logger.info("Suite changes computed", { snapshot: { snapshotId }, extra: { count: changes.length } });
    return changes;
}

interface AssignmentRow {
    testCaseId: string;
    planId: string | null;
    testCase: { id: string; name: string; slug: string; folderId: string };
    plan: { prompt: string } | null;
}

function byTestCaseId(assignments: AssignmentRow[]): Map<string, AssignmentRow> {
    return new Map(assignments.map((assignment) => [assignment.testCaseId, assignment]));
}

function toSuiteChange(entry: AssignmentDiffEntry<AssignmentRow>): SuiteChange {
    switch (entry.type) {
        case "added":
            return added(entry.current);
        case "updated":
            return updated(entry.current, entry.previous);
        case "removed":
            return removed(entry.previous);
    }
}

function added(assignment: AssignmentRow): AddedSuiteChange {
    return {
        type: "added",
        testCaseId: assignment.testCase.id,
        testCaseName: assignment.testCase.name,
        testCaseSlug: assignment.testCase.slug,
        testCaseFolderId: assignment.testCase.folderId,
        plan: promptOf(assignment),
    };
}

function updated(current: AssignmentRow, previous: AssignmentRow): UpdatedSuiteChange {
    return {
        type: "updated",
        testCaseId: current.testCase.id,
        testCaseName: current.testCase.name,
        testCaseSlug: current.testCase.slug,
        testCaseFolderId: current.testCase.folderId,
        plan: promptOf(current),
        previousPlan: promptOf(previous),
    };
}

function removed(previous: AssignmentRow): RemovedSuiteChange {
    return {
        type: "removed",
        testCaseId: previous.testCase.id,
        testCaseName: previous.testCase.name,
        testCaseSlug: previous.testCase.slug,
        testCaseFolderId: previous.testCase.folderId,
        previousPlan: promptOf(previous),
    };
}

function promptOf(assignment: AssignmentRow): string {
    return assignment.plan?.prompt ?? "";
}
