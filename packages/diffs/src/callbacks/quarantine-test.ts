import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { type TestSuiteUpdater, RemoveTest } from "@autonoma/test-updates";

interface QuarantineTestDeps {
    db: PrismaClient;
    updater: TestSuiteUpdater;
    applicationId: string;
}

export async function quarantineTest(slug: string, { db, updater, applicationId }: QuarantineTestDeps): Promise<void> {
    logger.info("Quarantining test", { slug });

    const testCase = await db.testCase.findFirst({
        where: { slug, applicationId },
        select: { id: true },
    });

    if (testCase == null) {
        logger.warn("Test case not found for quarantine", { slug });
        return;
    }

    await updater.apply(new RemoveTest({ testCaseId: testCase.id }));
    logger.info("Test quarantined (removed from snapshot)", { slug });
}
