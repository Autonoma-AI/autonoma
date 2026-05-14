import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { type TestSuiteUpdater, UpdateTest } from "@autonoma/test-updates";

interface ModifyTestParams {
    slug: string;
    newInstruction: string;
}

interface ModifyTestDeps {
    db: PrismaClient;
    updater: TestSuiteUpdater;
}

export async function modifyTest(
    { slug, newInstruction }: ModifyTestParams,
    { db, updater }: ModifyTestDeps,
): Promise<void> {
    logger.info("Modifying test", { slug });

    const assignment = await db.testCaseAssignment.findFirst({
        where: { snapshotId: updater.snapshotId, testCase: { slug } },
        select: {
            plan: { select: { scenarioId: true } },
            testCase: { select: { id: true, name: true } },
        },
    });

    if (assignment == null) {
        logger.warn("Test case not found for modify", { slug });
        return;
    }

    const testCaseId = assignment.testCase.id;
    const scenarioId = assignment.plan?.scenarioId ?? undefined;

    await updater.apply(new UpdateTest({ testCaseId, plan: newInstruction, scenarioId }));
    logger.info("Test modified", { slug });
}
