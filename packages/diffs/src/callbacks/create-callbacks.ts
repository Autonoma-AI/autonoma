import type { BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import type { GitHubInstallationClient } from "@autonoma/github";
import type { TestSuiteUpdater } from "@autonoma/test-updates";
import type { TestRunResult } from "../diffs-agent";
import type { TestDirectory } from "../test-directory";
import type { BugReport } from "../tools/bug-found-tool";
import { modifyTest } from "./modify-test";
import { reportBug } from "./report-bug";
import { triggerTestsAndWait, type TriggerRunWorkflowFn, type TriggerTestsParams } from "./trigger-tests";
import { updateSkill } from "./update-skill";

export interface CreateCallbacksParams {
    db: PrismaClient;
    updater: TestSuiteUpdater;
    applicationId: string;
    organizationId: string;
    testDirectory: TestDirectory;
    repoFullName: string;
    headSha: string;
    githubClient: GitHubInstallationClient;
    agentVersion: string;
    billingService: BillingService;
    triggerRunWorkflow: TriggerRunWorkflowFn;
}

export interface DiffsAgentCallbacks {
    triggerTestsAndWait(slugs: string[]): Promise<TestRunResult[]>;
    quarantineTest(slug: string): Promise<void>;
    modifyTest(slug: string, newInstruction: string): Promise<void>;
    updateSkill(skillId: string, newContent: string): Promise<void>;
    reportBug(report: BugReport): Promise<void>;
}

export function createCallbacks({
    db,
    updater,
    applicationId,
    organizationId,
    testDirectory,
    repoFullName,
    headSha,
    githubClient,
    agentVersion,
    billingService,
    triggerRunWorkflow,
}: CreateCallbacksParams): DiffsAgentCallbacks {
    const sharedDeps = { db, updater, applicationId, testDirectory };

    const triggerParams: TriggerTestsParams = {
        db,
        applicationId,
        organizationId,
        agentVersion,
        billingService,
        triggerRunWorkflow,
    };

    return {
        triggerTestsAndWait: (slugs) => triggerTestsAndWait(slugs, triggerParams),

        quarantineTest: async (_slug: string): Promise<void> => {
            // TODO: Implement when quarantine model/field is added
        },

        modifyTest: (slug, newInstruction) => modifyTest({ slug, newInstruction }, sharedDeps),

        updateSkill: (skillId, newContent) => updateSkill({ skillId, newContent }, sharedDeps),

        reportBug: (report) => reportBug(report, { repoFullName, headSha, githubClient }),
    };
}
