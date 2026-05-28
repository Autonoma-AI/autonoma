import type { PrismaClient } from "@autonoma/db";
import type { TestSuiteUpdater } from "@autonoma/test-updates";
import type { ReportedBug } from "../agents/resolution/tools/report-bug-tool";
import { addTest, type AddTestInput } from "./add-test";
import { modifyTest } from "./modify-test";
import { removeTest } from "./remove-test";
import { reportBug } from "./report-bug";

export interface ResolutionCallbacks {
    modifyTest(slug: string, newInstruction: string): Promise<void>;
    reportBug(bug: ReportedBug): Promise<void>;
    removeTest(slug: string): Promise<void>;
    addTest(test: AddTestInput): Promise<{ testCaseId: string; planId: string }>;
}

export interface CreateResolutionCallbacksParams {
    db: PrismaClient;
    updater: TestSuiteUpdater;
}

export function createResolutionCallbacks({ db, updater }: CreateResolutionCallbacksParams): ResolutionCallbacks {
    const modifyDeps = { db, updater };
    const removeDeps = { db, updater, applicationId: updater.applicationId };
    const addTestDeps = { updater };
    const reportBugDeps = { db, updater };

    return {
        modifyTest: (slug, newInstruction) => modifyTest({ slug, newInstruction }, modifyDeps),
        reportBug: (bug) => reportBug(bug, reportBugDeps),
        removeTest: (slug) => removeTest(slug, removeDeps),
        addTest: (test) => addTest(test, addTestDeps),
    };
}
