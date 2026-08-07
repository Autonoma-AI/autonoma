import type { Prisma, PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

const logger = rootLogger.child({ name: "readAssignments" });

/** One snapshot's membership row for one test: which snapshot assigns which test, pinning which plan. */
export interface SuiteAssignment {
    snapshotId: string;
    assignmentId: string;
    planId: string | null;
    testCaseId: string;
    slug: string;
    testName: string;
}

/**
 * Pure read: valid for open and terminal snapshots alike. Deliberately does not join plan prose or scenarios;
 * {@link readSuite} is the read for one snapshot's full suite.
 */
export async function readAssignments(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotIds: string[],
): Promise<SuiteAssignment[]> {
    if (snapshotIds.length === 0) return [];

    const assignments = await db.testCaseAssignment.findMany({
        where: { snapshotId: { in: snapshotIds } },
        select: {
            id: true,
            snapshotId: true,
            planId: true,
            testCase: { select: { id: true, slug: true, name: true } },
        },
    });

    logger.info("Read snapshot assignments", {
        extra: { snapshotCount: snapshotIds.length, assignmentCount: assignments.length },
    });
    return assignments.map((assignment) => ({
        snapshotId: assignment.snapshotId,
        assignmentId: assignment.id,
        planId: assignment.planId,
        testCaseId: assignment.testCase.id,
        slug: assignment.testCase.slug,
        testName: assignment.testCase.name,
    }));
}
