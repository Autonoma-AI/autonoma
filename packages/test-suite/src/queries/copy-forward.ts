import type { Prisma } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { forkScenarioDataForSnapshot } from "@autonoma/scenario";

const logger = rootLogger.child({ name: "copyForwardSuite" });

export interface CopyForwardParams {
    tx: Prisma.TransactionClient;
    sourceSnapshotId: string;
    targetSnapshotId: string;
}

/**
 * Carry a source snapshot's suite onto a freshly created snapshot: the test case assignments (by reference -
 * consecutive snapshots genuinely share `TestPlan` rows, which is why a plan is never mutated in place), and the
 * scenario data the scenario module forks alongside them.
 *
 * Runs inside the transaction that holds the branch lock, so every write is batched: a per-row create loop here
 * stalls every other opener on the branch.
 */
export async function copyForwardSuite({ tx, sourceSnapshotId, targetSnapshotId }: CopyForwardParams) {
    await copyTestCaseAssignments({ tx, sourceSnapshotId, targetSnapshotId });
    await forkScenarioDataForSnapshot({ tx, sourceSnapshotId, targetSnapshotId });
}

async function copyTestCaseAssignments({ tx, sourceSnapshotId, targetSnapshotId }: CopyForwardParams) {
    const assignments = await tx.testCaseAssignment.findMany({
        where: { snapshotId: sourceSnapshotId },
        select: { testCaseId: true, planId: true },
    });
    if (assignments.length === 0) return;

    logger.info("Copying test case assignments from source snapshot", {
        extra: { sourceSnapshotId, targetSnapshotId, assignmentCount: assignments.length },
    });
    await tx.testCaseAssignment.createMany({
        data: assignments.map((assignment) => ({
            snapshotId: targetSnapshotId,
            testCaseId: assignment.testCaseId,
            planId: assignment.planId ?? undefined,
        })),
    });
}
