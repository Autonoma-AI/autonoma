import type { PrismaClient } from "@autonoma/db";
import type { TestSuiteUpdater } from "@autonoma/test-updates";
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
    snapshotId: string;
    applicationId: string;
    organizationId: string;
}

export function createResolutionCallbacks({
    db,
    updater,
    snapshotId,
    applicationId,
    organizationId,
}: CreateResolutionCallbacksParams): ResolutionCallbacks {
    const modifyDeps = { db, updater };
    const quarantineDeps = { db, updater, applicationId };
    const addTestDeps = { updater };
    const reportBugDeps = { db, snapshotId, applicationId, organizationId };

    return {
        modifyTest: (slug, newInstruction) => modifyTest({ slug, newInstruction }, modifyDeps),
        reportBug: (bug) => reportBug(bug, reportBugDeps),
        quarantineTest: (slug) => quarantineTest(slug, quarantineDeps),
        addTest: (test) => addTest(test, addTestDeps),
    };
}
