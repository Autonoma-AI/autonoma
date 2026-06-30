import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import type { AffectedTest, Codebase, CreatedTest, FlowIndex } from "@autonoma/diffs";
import { type AffectedTestSpec, prepareRuns } from "@autonoma/diffs/prepare-runs";
import { type Logger, logger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { AddTest, TestSuiteUpdater } from "@autonoma/test-updates";
import type { PreparedRunInfo } from "@autonoma/workflow/activities";
import { uploadConversation } from "../upload-conversation";
import { assembleDiffsAgentInput } from "./assemble-input";
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
 * codebase clone, then applies the result (mints the tests the agent authored
 * and prepares replay runs for the affected tests). Returns the reasoning +
 * conversation URL for the activity to record on the DiffsJob.
 */
export async function runDiffsAnalysis({ snapshotId, codebase }: RunDiffsAnalysisParams): Promise<DiffsAnalysisResult> {
    logger.info("Starting diffs analysis");

    const { agentInput, importedAffectedTests, branchData } = await assembleDiffsAgentInput({ snapshotId, codebase });

    const { result: agentResult, conversation } = await runDiffsAgent({ input: agentInput, codebase });

    const conversationUrl = await uploadConversation({
        storage: S3Storage.createFromEnv(),
        snapshotId,
        phase: "analysis",
        conversation,
        logger: logger.child({ name: "uploadConversation" }),
    });

    const combinedAffectedTests = combineAffectedTests(importedAffectedTests, agentResult.affectedTests);

    logger.info("Agent analysis complete, applying results", {
        extra: {
            agentAffectedTests: agentResult.affectedTests.length,
            importedAffectedTests: importedAffectedTests.length,
            combined: combinedAffectedTests.length,
            createdTests: agentResult.createdTests.length,
        },
    });

    // Mint the authored tests first: each creates a test case + plan + a pending
    // generation, and the refinement loop seeds iteration 1 from the snapshot's
    // pending generations, so these must exist before the loop starts.
    await createAuthoredTests({
        snapshotId,
        organizationId: branchData.organizationId,
        flowIndex: agentInput.flowIndex,
        createdTests: agentResult.createdTests,
        logger: logger.child({ name: "createAuthoredTests" }),
    });

    const replays = await prepareReplays({
        snapshotId,
        applicationId: branchData.applicationId,
        organizationId: branchData.organizationId,
        affectedTests: combinedAffectedTests,
    });

    logger.info("Diffs analysis complete", {
        extra: { preparedRuns: replays.length, reasoning: agentResult.reasoning.slice(0, 200) },
    });

    return { replays, reasoning: agentResult.reasoning, conversationUrl };
}

/** Merge the deterministically-imported affected tests with the agent's, deduping by slug (imports win). */
function combineAffectedTests(imported: AffectedTest[], fromAgent: AffectedTest[]): AffectedTest[] {
    const bySlug = new Map(imported.map((t) => [t.slug, t] as const));
    for (const t of fromAgent) {
        if (!bySlug.has(t.slug)) bySlug.set(t.slug, t);
    }
    return Array.from(bySlug.values());
}

interface CreateAuthoredTestsParams {
    snapshotId: string;
    organizationId: string;
    flowIndex: FlowIndex;
    createdTests: CreatedTest[];
    logger: Logger;
}

/**
 * Mints each test the diffs agent authored as a TestCase + plan + assignment +
 * pending generation, storing the agent's `description` as the test case's
 * immutable `description`. The `create_test` schema requires a meaningful
 * (length-checked) description, so the value minted here is always a real,
 * non-trivial, durable statement of what the test does - which downstream
 * consumers (e.g. `scenario_unsupported`) rely on. The `coverageJustification`
 * is a creation-time dedup gate only and is deliberately not persisted.
 *
 * The folder name was already validated against this flow index at the tool
 * boundary, so an unresolved folder here is a hard invariant violation.
 */
async function createAuthoredTests(params: CreateAuthoredTestsParams): Promise<void> {
    const { snapshotId, organizationId, flowIndex, createdTests, logger } = params;
    if (createdTests.length === 0) return;

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({ db, snapshotId, organizationId });

    for (const test of createdTests) {
        const folder = flowIndex.getFlow(test.folderName);
        if (folder == null) {
            throw new Error(`Folder "${test.folderName}" not found for authored test "${test.name}"`);
        }

        const { testCaseId, planId } = await updater.apply(
            new AddTest({
                name: test.name,
                plan: test.plan,
                description: test.description,
                folderId: folder.id,
                scenarioId: test.scenarioId,
            }),
        );
        logger.info("Authored test created and generation queued", { extra: { name: test.name, testCaseId, planId } });
    }
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
