import type { PrismaClient } from "@autonoma/db";
import type { BugLinker } from "@autonoma/review";
import type { TestSuiteUpdater } from "@autonoma/test-updates";
import type { TestDirectory } from "../test-directory";
import type { ReportedBug } from "../tools/report-bug-tool";
import { addTest, type AddTestInput } from "./add-test";
import { modifyTest } from "./modify-test";
import { quarantineTest } from "./quarantine-test";
import { reportBug } from "./report-bug";

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
    organizationId: string;
    testDirectory: TestDirectory;
    bugLinker: BugLinker;
}

export function createResolutionCallbacks({
    db,
    updater,
    applicationId,
    organizationId,
    testDirectory,
    bugLinker,
}: CreateResolutionCallbacksParams): ResolutionCallbacks {
    const modifyDeps = { db, updater, applicationId, testDirectory };
    const quarantineDeps = { db, updater, applicationId };
    const addTestDeps = { updater };
    const reportBugDeps = { db, bugLinker, branchId: updater.branchId, applicationId, organizationId };

    return {
        modifyTest: (slug, newInstruction) => modifyTest({ slug, newInstruction }, modifyDeps),
        reportBug: (bug) => reportBug(bug, reportBugDeps),
        quarantineTest: (slug) => quarantineTest(slug, quarantineDeps),
        addTest: (test) => addTest(test, addTestDeps),
    };
}
