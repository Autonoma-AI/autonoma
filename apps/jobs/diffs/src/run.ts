import fs from "fs/promises";
import { db } from "@autonoma/db";
import type { AffectedTest, DiffsAgentResult } from "@autonoma/diffs";
import { extendObservabilityContext, logger, withObservabilityContext } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { createDiffsServices } from "./create-services";
import { loadBranchData, loadDiffsContext } from "./load-context";
import { runMergeFlow } from "./merge-flow";
import { runDiffsAgent } from "./run-diffs-agent";
import { uploadConversation } from "./upload-conversation";

export interface DiffsAnalysisResult extends DiffsAgentResult {
    /**
     * Tests whose plan was deterministically imported from a merge source during
     * Phase 1 merge handling. Callers merge these with `affectedTests` before
     * dispatching replay runs.
     */
    importedAffectedTests: AffectedTest[];
    /** S3 URL of the persisted analysis conversation, or undefined if upload was skipped/failed. */
    conversationUrl?: string;
}

export async function runDiffsAnalysis(snapshotId: string): Promise<DiffsAnalysisResult> {
    return await withObservabilityContext({ snapshot: { snapshotId } }, () => runDiffsAnalysisInner(snapshotId));
}

async function runDiffsAnalysisInner(snapshotId: string): Promise<DiffsAnalysisResult> {
    logger.info("Starting diffs analysis job");

    const { githubApp, updater } = await createDiffsServices(snapshotId);
    const branchId = updater.branchId;

    const headSha = updater.headSha;
    const baseSha = updater.baseSha;

    if (headSha == null || baseSha == null) {
        throw new Error(
            `Snapshot ${snapshotId} (branch ${branchId}) is missing required SHAs (headSha: ${headSha ?? "null"}, baseSha: ${baseSha ?? "null"})`,
        );
    }

    extendObservabilityContext({
        branch: { branchId },
        snapshot: { snapshotId, headSha, baseSha },
    });
    logger.info("Loaded pending snapshot");

    const branchData = await loadBranchData(branchId, githubApp);
    extendObservabilityContext({ application: { applicationId: branchData.applicationId } });
    logger.info("Loaded branch data", { extra: { fullName: branchData.fullName } });

    const githubClient = await githubApp.getInstallationClient(Number(branchData.installationId));

    // Clean up any existing repo directory before cloning
    await fs.rm("/tmp/repo", { recursive: true, force: true });

    try {
        const repoDir = await githubClient.cloneRepository({
            fullName: branchData.fullName,
            headSha,
            baseSha,
            targetDir: "/tmp/repo",
        });

        const suiteInfo = await updater.currentTestSuiteInfo();
        const { input, flowIndex } = await loadDiffsContext(branchData.applicationId, suiteInfo, headSha, baseSha);
        logger.info("Loaded diffs context", {
            extra: {
                existingTests: input.existingTests.length,
            },
        });

        const mergeResult = await runOptionalMergeFlow({
            branchData,
            githubClient,
            repoDir,
            baseSha,
            headSha,
            snapshotId,
        });

        const importedSlugs = new Set(mergeResult.importedAffectedTests.map((t) => t.slug));

        const agentInput = {
            ...input,
            existingTests: input.existingTests.filter((t) => !importedSlugs.has(t.slug)),
            merges: mergeResult.merges,
            preClassifiedConflicts: mergeResult.preClassifiedConflicts,
        };

        const agentResult = await runDiffsAgent({
            input: agentInput,
            repoDir,
            flowIndex,
        });

        const conversationUrl = await uploadConversation({
            storage: S3Storage.createFromEnv(),
            snapshotId,
            phase: "analysis",
            conversation: agentResult.conversation,
            logger: logger.child({ name: "uploadConversation" }),
        });

        return {
            ...agentResult,
            importedAffectedTests: mergeResult.importedAffectedTests,
            conversationUrl,
        };
    } finally {
        // Clean up the repo directory after analysis
        await fs.rm("/tmp/repo", { recursive: true, force: true });
    }
}

interface OptionalMergeFlowParams {
    branchData: Awaited<ReturnType<typeof loadBranchData>>;
    githubClient: Awaited<
        ReturnType<Awaited<ReturnType<typeof createDiffsServices>>["githubApp"]["getInstallationClient"]>
    >;
    repoDir: string;
    baseSha: string;
    headSha: string;
    snapshotId: string;
}

async function runOptionalMergeFlow({
    branchData,
    githubClient,
    repoDir,
    baseSha,
    headSha,
    snapshotId,
}: OptionalMergeFlowParams) {
    if (!branchData.isMainBranch) {
        logger.info(
            "Branch is not the application main branch; skipping merge flow (Phase 1 only handles feat/x -> main)",
        );
        return { merges: [], preClassifiedConflicts: [], importedAffectedTests: [] };
    }

    const [owner, repo] = branchData.fullName.split("/");
    if (owner == null || repo == null) {
        logger.warn("Unexpected fullName format; skipping merge flow", { fullName: branchData.fullName });
        return { merges: [], preClassifiedConflicts: [], importedAffectedTests: [] };
    }

    return await runMergeFlow({
        db,
        githubClient,
        owner,
        repo,
        targetBranchRef: branchData.defaultBranch,
        baseSha,
        headSha,
        repoDir,
        targetSnapshotId: snapshotId,
        applicationId: branchData.applicationId,
    });
}
