import { logger } from "@autonoma/logger";
import { AddTest as AddTestChange, type TestSuiteUpdater } from "@autonoma/test-updates";
import type { GeneratedTest } from "../tools/add-test-tool";

interface AddTestDeps {
    updater: TestSuiteUpdater;
}

export type AddTestInput = Omit<GeneratedTest, "folderName"> & { folderId: string };

export async function addTest(test: AddTestInput, { updater }: AddTestDeps): Promise<void> {
    logger.info("Adding new test", { name: test.name });

    await updater.apply(
        new AddTestChange({
            name: test.name,
            plan: test.instruction,
            folderId: test.folderId,
        }),
    );

    logger.info("New test added to snapshot", { name: test.name });
}
