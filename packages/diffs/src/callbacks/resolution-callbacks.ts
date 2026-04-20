import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import type { TestSuiteUpdater } from "@autonoma/test-updates";
import type { TestDirectory } from "../test-directory";
import type { ReportedBug } from "../tools/report-bug-tool";
import { addTest, type AddTestInput } from "./add-test";
import { modifyTest } from "./modify-test";
import { quarantineTest } from "./quarantine-test";

export interface ResolutionCallbacks {
    modifyTest(slug: string, newInstruction: string): Promise<void>;
    reportBug(bug: ReportedBug): Promise<void>;
    quarantineTest(slug: string): Promise<void>;
    addTest(test: AddTestInput): Promise<void>;
}

export interface CreateResolutionCallbacksParams {
    db: PrismaClient;
    updater: TestSuiteUpdater;
    applicationId: string;
    testDirectory: TestDirectory;
}

export function createResolutionCallbacks({
    db,
    updater,
    applicationId,
    testDirectory,
}: CreateResolutionCallbacksParams): ResolutionCallbacks {
    const modifyDeps = { db, updater, applicationId, testDirectory };
    const quarantineDeps = { db, updater, applicationId };
    const addTestDeps = { updater };

    return {
        modifyTest: (slug, newInstruction) => modifyTest({ slug, newInstruction }, modifyDeps),
        reportBug: async (bug) => {
            logger.info("Reporting bug found in diff resolution", { summary: bug.summary });
            // TODO: Implement
        },
        quarantineTest: (slug) => quarantineTest(slug, quarantineDeps),
        addTest: (test) => addTest(test, addTestDeps),
    };
}
