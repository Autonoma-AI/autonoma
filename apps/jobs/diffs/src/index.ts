import { MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { createCallbacks, DiffsAgent } from "@autonoma/diffs";
import { GitHubApp } from "@autonoma/github";
import { logger, runWithSentry } from "@autonoma/logger";
import { CommitDiffHandler, TestSuiteUpdater } from "@autonoma/test-updates";
import { ArgoGenerationProvider } from "@autonoma/test-updates/argo";
import type { Architecture } from "@autonoma/types";
import { triggerDiffsJob, triggerRunWorkflow } from "@autonoma/workflow";
import * as Sentry from "@sentry/node";
import { env } from "./env";
import { loadBranchData, loadDiffsContext } from "./load-context";

const githubApp = new GitHubApp({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
    appSlug: env.GITHUB_APP_SLUG,
});

async function main(): Promise<void> {
    const { BRANCH_ID } = env;

    Sentry.setTag("branchId", BRANCH_ID);

    logger.info("Starting diffs analysis job", { branchId: BRANCH_ID });

    const jobProvider = new ArgoGenerationProvider({
        agentVersion: env.AGENT_VERSION,
    });
    const commitDiffHandler = new CommitDiffHandler(db, githubApp, triggerDiffsJob);
    const updater = await TestSuiteUpdater.continueUpdate({ db, branchId: BRANCH_ID, jobProvider, commitDiffHandler });

    const headSha = updater.headSha;
    const baseSha = updater.baseSha;

    if (headSha == null || baseSha == null) {
        throw new Error(
            `Pending snapshot for branch ${BRANCH_ID} is missing required SHAs (headSha: ${headSha ?? "null"}, baseSha: ${baseSha ?? "null"})`,
        );
    }

    Sentry.setTag("headSha", headSha);

    logger.info("Loaded pending snapshot", { headSha, baseSha });

    const branchData = await loadBranchData(BRANCH_ID);
    logger.info("Loaded branch data", {
        applicationId: branchData.applicationId,
        fullName: branchData.fullName,
    });

    const githubClient = await githubApp.getInstallationClient(Number(branchData.installationId));

    const repoDir = await githubClient.cloneRepository({
        fullName: branchData.fullName,
        headSha,
        baseSha,
        targetDir: "/tmp/repo",
    });

    const suiteInfo = await updater.currentTestSuiteInfo();
    const { input, testDirectory } = await loadDiffsContext(suiteInfo, repoDir, headSha, baseSha);
    logger.info("Loaded diffs context", {
        affectedFiles: input.analysis.affectedFiles.length,
        existingTests: input.existingTests.length,
        existingSkills: input.existingSkills.length,
    });

    const registry = new ModelRegistry({
        models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
    });
    const model = registry.getModel({ model: "flash", tag: "diffs-job" });

    const billingService = createBillingService(db);

    const callbacks = createCallbacks({
        db,
        updater,
        applicationId: branchData.applicationId,
        organizationId: branchData.organizationId,
        repoFullName: branchData.fullName,
        headSha,
        testDirectory,
        githubClient,
        agentVersion: env.AGENT_VERSION,
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

    await updater.queuePendingGenerations({ autoActivate: true });
}

await runWithSentry({ name: "diffs-job", tags: { branch_id: env.BRANCH_ID }, dsn: env.SENTRY_DSN }, main);
