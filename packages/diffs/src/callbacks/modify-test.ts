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
    applicationId: string;
    testDirectory: TestDirectory;
}

export async function modifyTest(
    { slug, newInstruction }: ModifyTestParams,
    { db, updater, applicationId, testDirectory }: ModifyTestDeps,
): Promise<void> {
    logger.info("Modifying test", { slug });

    const testCase = await db.testCase.findFirst({
        where: { slug, applicationId },
        select: { id: true, name: true },
    });

    if (testCase == null) {
        logger.warn("Test case not found for modify", { slug });
        return;
    }

    await updater.apply(new UpdateTest({ testCaseId: testCase.id, plan: newInstruction }));
    await testDirectory.writeTest({ slug, name: testCase.name, prompt: newInstruction });
    logger.info("Test modified and written to disk", { slug });
}
