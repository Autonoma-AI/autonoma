import type { PrismaClient } from "@autonoma/db";
import type { GitHubInstallationClient } from "@autonoma/github";
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
    testDirectory: TestDirectory;
    githubClient: GitHubInstallationClient;
    repoId: number;
    headSha: string;
}

export function createResolutionCallbacks({
    db,
    updater,
    applicationId,
    testDirectory,
    githubClient,
    repoId,
    headSha,
}: CreateResolutionCallbacksParams): ResolutionCallbacks {
    const modifyDeps = { db, updater, applicationId, testDirectory };
    const quarantineDeps = { db, updater, applicationId };
    const addTestDeps = { updater };
    const bugDeps = { repoId, headSha, githubClient };

    return {
        modifyTest: (slug, newInstruction) => modifyTest({ slug, newInstruction }, modifyDeps),
        reportBug: (bug) => reportBug(bug, bugDeps),
        quarantineTest: (slug) => quarantineTest(slug, quarantineDeps),
        addTest: (test) => addTest(test, addTestDeps),
    };
}
