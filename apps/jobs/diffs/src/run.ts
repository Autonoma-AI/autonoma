import { logger } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { createDiffsServices } from "./create-services";
import { env } from "./env";
import { loadBranchData, loadDiffsContext } from "./load-context";
import { runDiffsAgent } from "./run-diffs-agent";

export async function runDiffsAnalysis(branchId: string): Promise<void> {
    Sentry.setTag("branchId", branchId);
    logger.info("Starting diffs analysis job", { branchId });

    const { githubApp, updater } = await createDiffsServices(branchId);

    const headSha = updater.headSha;
    const baseSha = updater.baseSha;

    if (headSha == null || baseSha == null) {
        throw new Error(
            `Pending snapshot for branch ${branchId} is missing required SHAs (headSha: ${headSha ?? "null"}, baseSha: ${baseSha ?? "null"})`,
        );
    }

    Sentry.setTag("headSha", headSha);
    logger.info("Loaded pending snapshot", { headSha, baseSha });

    const branchData = await loadBranchData(branchId);
    logger.info("Loaded branch data", { applicationId: branchData.applicationId, fullName: branchData.fullName });

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

    await runDiffsAgent({
        input,
        updater,
        applicationId: branchData.applicationId,
        organizationId: branchData.organizationId,
        agentVersion: env.AGENT_VERSION,
        repoFullName: branchData.fullName,
        headSha,
        repoDir,
        testDirectory,
        githubClient,
    });

    await updater.queuePendingGenerations({ autoActivate: true });
}
