import { MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { createCallbacks, DiffsAgent } from "@autonoma/diffs";
import type { TestDirectory } from "@autonoma/diffs";
import type { DiffsAgentInput } from "@autonoma/diffs";
import type { GitHubInstallationClient } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import type { TestSuiteUpdater } from "@autonoma/test-updates";
import type { Architecture } from "@autonoma/types";
import { triggerRunWorkflow } from "@autonoma/workflow";

interface RunDiffsAgentParams {
    input: DiffsAgentInput;
    updater: TestSuiteUpdater;
    applicationId: string;
    organizationId: string;
    agentVersion: string;
    repoFullName: string;
    headSha: string;
    repoDir: string;
    testDirectory: TestDirectory;
    githubClient: GitHubInstallationClient;
}

export async function runDiffsAgent(params: RunDiffsAgentParams): Promise<void> {
    const {
        input,
        updater,
        applicationId,
        organizationId,
        agentVersion,
        repoFullName,
        headSha,
        repoDir,
        testDirectory,
        githubClient,
    } = params;

    const registry = new ModelRegistry({
        models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
    });
    const model = registry.getModel({ model: "flash", tag: "diffs-job" });
    const billingService = createBillingService(db);

    const callbacks = createCallbacks({
        db,
        updater,
        applicationId,
        organizationId,
        repoFullName,
        headSha,
        testDirectory,
        githubClient,
        agentVersion,
        billingService,
        triggerRunWorkflow: (params) =>
            triggerRunWorkflow({ ...params, architecture: params.architecture as Architecture }),
    });

    const agent = new DiffsAgent({
        model,
        workingDirectory: repoDir,
        callbacks,
        maxSteps: 50,
    });

    const startTime = Date.now();
    const result = await agent.analyze(input);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    logger.info("Diffs analysis complete", {
        elapsed: `${elapsed}s`,
        testActions: result.testActions.length,
        bugReports: result.bugReports.length,
        skillUpdates: result.skillUpdates.length,
        newTests: result.newTests.length,
        reasoning: result.reasoning.slice(0, 500),
        modelUsage: registry.modelUsage,
    });
}
