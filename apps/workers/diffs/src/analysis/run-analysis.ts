import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import type { AffectedTest, Codebase } from "@autonoma/diffs";
import { type AffectedTestSpec, prepareRuns } from "@autonoma/diffs/prepare-runs";
import { createDiffsServices } from "@autonoma/job-diffs/create-services";
import { loadBranchData, loadDiffsContext } from "@autonoma/job-diffs/load-context";
import { uploadConversation } from "@autonoma/job-diffs/upload-conversation";
import { logger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import type { PreparedRunInfo } from "@autonoma/workflow/activities";
import { runMergeFlow } from "./merge-flow";
import { runDiffsAgent } from "./run-diffs-agent";

export interface RunDiffsAnalysisParams {
    snapshotId: string;
    /** The on-disk clone (at base + head SHAs), acquired by the activity via `withCodebaseForSnapshot`. */
    codebase: Codebase;
}

export interface DiffsAnalysisResult {
    /** Runs prepared for replay - one per affected test that resolved to a runnable assignment. */
    replays: PreparedRunInfo[];
    /** The agent's analysis reasoning, persisted by the activity onto the DiffsJob. */
    reasoning: string;
    /** S3 URL of the persisted analysis conversation, or undefined if upload was skipped/failed. */
    conversationUrl?: string;
}

/**
 * Analysis runner: runs the merge flow + DiffsAgent against the provided
 * codebase clone, then applies the result (persists test candidates and
 * prepares replay runs). Returns the reasoning + conversation URL for the
 * activity to record on the DiffsJob.
 */
export async function runDiffsAnalysis({ snapshotId, codebase }: RunDiffsAnalysisParams): Promise<DiffsAnalysisResult> {
    logger.info("Starting diffs analysis");

    const { githubApp, updater } = await createDiffsServices(snapshotId);
    const branchId = updater.branchId;

    const headSha = updater.headSha;
    const baseSha = updater.baseSha;

    if (headSha == null || baseSha == null) {
        throw new Error(
            `Snapshot ${snapshotId} (branch ${branchId}) is missing required SHAs (headSha: ${headSha ?? "null"}, baseSha: ${baseSha ?? "null"})`,
        );
    }

    const branchData = await loadBranchData(branchId, githubApp);
    logger.info("Loaded branch data", { extra: { fullName: branchData.fullName } });

    const githubClient = await githubApp.getInstallationClient(Number(branchData.installationId));

    const suiteInfo = await updater.currentTestSuiteInfo();
    const { metadata } = await loadDiffsContext(branchData.applicationId, suiteInfo, headSha, baseSha);
    logger.info("Loaded diffs context", { extra: { existingTests: metadata.existingTests.length } });

    const mergeResult = await runOptionalMergeFlow({
        branchData,
        githubClient,
        repoDir: codebase.root,
        baseSha,
        headSha,
        snapshotId,
    });

    const importedSlugs = new Set(mergeResult.importedAffectedTests.map((t) => t.slug));

    const agentInput = {
        ...metadata,
        existingTests: metadata.existingTests.filter((t) => !importedSlugs.has(t.slug)),
        merges: mergeResult.merges,
        preClassifiedConflicts: mergeResult.preClassifiedConflicts,
    };

    const { result: agentResult, conversation } = await runDiffsAgent({ input: agentInput, codebase });

    const conversationUrl = await uploadConversation({
        storage: S3Storage.createFromEnv(),
        snapshotId,
        phase: "analysis",
        conversation,
        logger: logger.child({ name: "uploadConversation" }),
    });

    const combinedAffectedTests = combineAffectedTests(mergeResult.importedAffectedTests, agentResult.affectedTests);

    logger.info("Agent analysis complete, applying results", {
        extra: {
            agentAffectedTests: agentResult.affectedTests.length,
            importedAffectedTests: mergeResult.importedAffectedTests.length,
            combined: combinedAffectedTests.length,
            testCandidates: agentResult.testCandidates.length,
        },
    });

    await persistTestCandidates(snapshotId, branchData.organizationId, agentResult.testCandidates);

    const replays = await prepareReplays({
        snapshotId,
        applicationId: branchData.applicationId,
        organizationId: branchData.organizationId,
        affectedTests: combinedAffectedTests,
    });

    logger.info("Diffs analysis complete", {
        extra: { preparedRuns: replays.length, reasoning: agentResult.reasoning.slice(0, 200) },
    });

    const output: DiffsAnalysisResult = { replays, reasoning: agentResult.reasoning };
    if (conversationUrl != null) output.conversationUrl = conversationUrl;
    return output;
}

/** Merge the deterministically-imported affected tests with the agent's, deduping by slug (imports win). */
function combineAffectedTests(imported: AffectedTest[], fromAgent: AffectedTest[]): AffectedTest[] {
    const bySlug = new Map(imported.map((t) => [t.slug, t] as const));
    for (const t of fromAgent) {
        if (!bySlug.has(t.slug)) bySlug.set(t.slug, t);
    }
    return Array.from(bySlug.values());
}

async function persistTestCandidates(
    snapshotId: string,
    organizationId: string,
    candidates: { name: string; instruction: string; reasoning: string }[],
): Promise<void> {
    if (candidates.length === 0) return;

    await db.testCandidate.createMany({
        data: candidates.map((c) => ({
            snapshotId,
            organizationId,
            name: c.name,
            instruction: c.instruction,
            reasoning: c.reasoning,
        })),
    });
}

interface PrepareReplaysParams {
    snapshotId: string;
    applicationId: string;
    organizationId: string;
    affectedTests: AffectedTest[];
}

async function prepareReplays({
    snapshotId,
    applicationId,
    organizationId,
    affectedTests,
}: PrepareReplaysParams): Promise<PreparedRunInfo[]> {
    if (affectedTests.length === 0) return [];

    const billingService = createBillingService(db);
    const specs: AffectedTestSpec[] = affectedTests.map((t) => ({
        slug: t.slug,
        affectedReason: t.affectedReason,
        reasoning: t.reasoning,
    }));

    const runs = await prepareRuns(specs, {
        db,
        snapshotId,
        applicationId,
        organizationId,
        billingService,
    });

    return runs.map((r) => ({
        runId: r.runId,
        slug: r.slug,
        architecture: r.architecture,
        scenarioId: r.scenarioId,
    }));
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
