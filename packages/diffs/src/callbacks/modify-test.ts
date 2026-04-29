import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { type TestSuiteUpdater, UpdateTest } from "@autonoma/test-updates";
import type { TestDirectory } from "../test-directory";

interface ModifyTestParams {
    slug: string;
    newInstruction: string;
}

interface ModifyTestDeps {
    db: PrismaClient;
    updater: TestSuiteUpdater;
    testDirectory: TestDirectory;
}

export async function modifyTest(
    { slug, newInstruction }: ModifyTestParams,
    { db, updater, testDirectory }: ModifyTestDeps,
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
    const name = assignment.testCase.name;
    const scenarioId = assignment.plan?.scenarioId ?? undefined;

    await updater.apply(new UpdateTest({ testCaseId, plan: newInstruction, scenarioId }));
    await testDirectory.writeTest({ slug, name, prompt: newInstruction });
    logger.info("Test modified and written to disk", { slug });
}
