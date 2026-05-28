import { logger } from "@autonoma/logger";
import { AddTest as AddTestChange, type TestSuiteUpdater } from "@autonoma/test-updates";
import type { GeneratedTest } from "../agents/resolution/tools/add-test-tool";

interface AddTestDeps {
    updater: TestSuiteUpdater;
}

export type AddTestInput = Omit<GeneratedTest, "folderName"> & { folderId: string };

export async function addTest(
    test: AddTestInput,
    { updater }: AddTestDeps,
): Promise<{ testCaseId: string; planId: string }> {
    logger.info("Adding new test", { name: test.name });

    const result = await updater.apply(
        new AddTestChange({
            name: test.name,
            plan: test.instruction,
            folderId: test.folderId,
            scenarioId: test.scenarioId,
        }),
    );

    logger.info("New test added to snapshot", { name: test.name, testCaseId: result.testCaseId });

    return result;
}
