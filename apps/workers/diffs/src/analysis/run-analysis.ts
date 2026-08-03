import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import type { AffectedTest, Codebase, CreatedTest, FlowIndex } from "@autonoma/diffs";
import { type AffectedTestSpec, prepareAffectedTestGenerations } from "@autonoma/diffs/prepare-affected-tests";
import { type Logger, logger } from "@autonoma/logger";
import { AddTest, TestSuiteUpdater } from "@autonoma/test-updates";
import { assembleDiffsAgentInput } from "./assemble-input";
import { runDiffsAgent } from "./run-diffs-agent";

export interface RunDiffsAnalysisParams {
    snapshotId: string;
    /** The on-disk clone (at base + head SHAs), acquired by the activity via `withCodebaseForSnapshot`. */
    codebase: Codebase;
}

export interface DiffsAnalysisResult {
    /** The agent's analysis reasoning, persisted by the activity onto the DiffsJob. */
    reasoning: string;
    /** S3 URL of the persisted analysis conversation, or undefined if upload was skipped/failed. */
    conversationUrl?: string;
}

/**
 * Analysis runner: runs the DiffsAgent against the provided codebase clone, then
 * applies the result - mints the tests the agent authored and queues a pending
 * generation for each affected test. Both feed the refinement loop's iteration 1
 * (which generates + heals them; there is no replay step). Returns the reasoning
 * + conversation URL for the activity to record on the DiffsJob.
 */
export async function runDiffsAnalysis({ snapshotId, codebase }: RunDiffsAnalysisParams): Promise<DiffsAnalysisResult> {
    logger.info("Starting diffs analysis");

    const { agentInput, branchData } = await assembleDiffsAgentInput({ snapshotId });

    const { result: agentResult, conversationUrl } = await runDiffsAgent({ snapshotId, input: agentInput, codebase });

    logger.info("Agent analysis complete, applying results", {
        extra: {
            affectedTests: agentResult.affectedTests.length,
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

    const preparedCount = await prepareAffectedGenerations({
        snapshotId,
        applicationId: branchData.applicationId,
        organizationId: branchData.organizationId,
        affectedTests: agentResult.affectedTests,
    });

    logger.info("Diffs analysis complete", {
        extra: { preparedGenerations: preparedCount, reasoning: agentResult.reasoning.slice(0, 200) },
    });

    return { reasoning: agentResult.reasoning, conversationUrl };
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

interface PrepareAffectedGenerationsParams {
    snapshotId: string;
    applicationId: string;
    organizationId: string;
    affectedTests: AffectedTest[];
}

/** Queues a pending generation for each affected test; returns how many were prepared. */
async function prepareAffectedGenerations({
    snapshotId,
    applicationId,
    organizationId,
    affectedTests,
}: PrepareAffectedGenerationsParams): Promise<number> {
    if (affectedTests.length === 0) return 0;

    const billingService = createBillingService(db);
    const specs: AffectedTestSpec[] = affectedTests.map((t) => ({
        slug: t.slug,
        affectedReason: t.affectedReason,
        reasoning: t.reasoning,
    }));

    const prepared = await prepareAffectedTestGenerations(specs, {
        db,
        snapshotId,
        applicationId,
        organizationId,
        billingService,
    });

    return prepared.length;
}
