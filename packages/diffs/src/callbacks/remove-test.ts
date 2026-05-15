import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { type TestSuiteUpdater, RemoveTest } from "@autonoma/test-updates";

interface RemoveTestDeps {
    db: PrismaClient;
    updater: TestSuiteUpdater;
    applicationId: string;
}

export async function removeTest(slug: string, { db, updater, applicationId }: RemoveTestDeps): Promise<void> {
    logger.info("Removing test from suite", { slug });

    const testCase = await db.testCase.findFirst({
        where: { slug, applicationId },
        select: { id: true },
    });

    if (testCase == null) {
        logger.warn("Test case not found for removal", { slug });
        return;
    }

    await updater.apply(new RemoveTest({ testCaseId: testCase.id }));
    logger.info("Test removed from snapshot", { slug });
}
