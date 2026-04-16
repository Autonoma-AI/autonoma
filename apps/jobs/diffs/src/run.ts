import type { DiffsAgentResult } from "@autonoma/diffs";
import { logger } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { createDiffsServices } from "./create-services";
import { loadBranchData, loadDiffsContext } from "./load-context";
import { runDiffsAgent } from "./run-diffs-agent";

export async function runDiffsAnalysis(branchId: string): Promise<DiffsAgentResult> {
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

    const branchData = await loadBranchData(branchId, githubApp);
    logger.info("Loaded branch data", { applicationId: branchData.applicationId, fullName: branchData.fullName });

    const githubClient = await githubApp.getInstallationClient(Number(branchData.installationId));

    const repoDir = await githubClient.cloneRepository({
        fullName: branchData.fullName,
        headSha,
        baseSha,
        targetDir: "/tmp/repo",
    });

    const suiteInfo = await updater.currentTestSuiteInfo();
    const { input, testDirectory, flowIndex } = await loadDiffsContext(
        branchData.applicationId,
        suiteInfo,
        repoDir,
        headSha,
        baseSha,
    );
    logger.info("Loaded diffs context", {
        existingTests: input.existingTests.length,
        existingSkills: input.existingSkills.length,
    });

    return await runDiffsAgent({
        input,
        repoDir,
        testDirectory,
        flowIndex,
    });
}
