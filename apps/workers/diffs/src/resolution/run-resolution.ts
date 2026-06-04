import { db } from "@autonoma/db";
import type { Codebase } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import type { ModelMessage } from "ai";
import { createDiffsServices } from "../create-services";
import { uploadConversation } from "../upload-conversation";
import { assembleResolutionAgentInput } from "./assemble-input";
import { type AcceptedCandidateLink, runResolutionAgent } from "./run-resolution-agent";

export interface RunDiffsResolutionParams {
    snapshotId: string;
    /** The on-disk clone (at base + head SHAs), acquired by the activity via `withCodebaseForSnapshot`. */
    codebase: Codebase;
}

export interface DiffsResolutionResult {
    /** The agent's resolution reasoning, persisted by the activity onto the DiffsJob. */
    reasoning: string;
    /** S3 URL of the persisted resolution conversation, or undefined if upload was skipped/failed. */
    conversationUrl?: string;
}

/**
 * Resolution runner: runs the ResolutionAgent against the provided codebase
 * clone, then applies the result (the agent runner dispatches the modify /
 * remove / report-bug / add-test callbacks) and links the outcomes (modified
 * tests to their generations, accepted candidates to their new test cases).
 * Returns the reasoning + conversation URL for the activity to record on the
 * DiffsJob.
 */
export async function runDiffsResolution({
    snapshotId,
    codebase,
}: RunDiffsResolutionParams): Promise<DiffsResolutionResult> {
    const logger = rootLogger.child({ name: "runDiffsResolution" });
    logger.info("Starting diffs resolution");

    const { agentInput } = await assembleResolutionAgentInput({ snapshotId });

    const verdictCount = agentInput.verdicts.length;
    const candidateCount = agentInput.testCandidates.length;
    const shouldRunAgent = verdictCount > 0 || candidateCount > 0;

    let resolutionReasoning = "";
    let modifiedSlugs: string[] = [];
    let newTestsCount = 0;
    let acceptedCandidates: AcceptedCandidateLink[] = [];
    let resolutionConversation: ModelMessage[] = [];

    if (!shouldRunAgent) {
        logger.info("Resolution skipped - no runs and no candidates");
    } else {
        const { updater } = await createDiffsServices(snapshotId);

        logger.info("Running resolution agent", {
            extra: { verdictCount, candidateCount },
        });

        const agentResult = await runResolutionAgent({ input: agentInput, db, updater, codebase });

        resolutionReasoning = agentResult.reasoning;
        modifiedSlugs = agentResult.modifiedTests.map((t) => t.slug);
        newTestsCount = agentResult.newTests.length;
        acceptedCandidates = agentResult.accepted;
        resolutionConversation = agentResult.conversation;
    }

    await linkResolutionOutcomes({
        snapshotId,
        modifiedSlugs,
        accepted: acceptedCandidates,
        logger,
    });

    const resolutionConversationUrl = await uploadConversation({
        storage: S3Storage.createFromEnv(),
        snapshotId,
        phase: "resolution",
        conversation: resolutionConversation,
        logger,
    });

    logger.info("Diffs resolution complete", {
        extra: {
            modifiedTests: modifiedSlugs.length,
            newTests: newTestsCount,
            acceptedCandidates: acceptedCandidates.length,
        },
    });

    const output: DiffsResolutionResult = { reasoning: resolutionReasoning };
    if (resolutionConversationUrl != null) output.conversationUrl = resolutionConversationUrl;
    return output;
}

interface LinkResolutionOutcomesParams {
    snapshotId: string;
    modifiedSlugs: string[];
    accepted: AcceptedCandidateLink[];
    logger: ReturnType<typeof rootLogger.child>;
}

async function linkResolutionOutcomes({
    snapshotId,
    modifiedSlugs,
    accepted,
    logger,
}: LinkResolutionOutcomesParams): Promise<void> {
    if (modifiedSlugs.length > 0) {
        await linkModifiedToGenerations(snapshotId, modifiedSlugs, logger);
    }

    await reconcileTestCandidates(snapshotId, accepted, logger);
}

async function linkModifiedToGenerations(
    snapshotId: string,
    slugs: string[],
    logger: ReturnType<typeof rootLogger.child>,
): Promise<void> {
    const generations = await db.testGeneration.findMany({
        where: {
            snapshotId,
            testPlan: { testCase: { slug: { in: slugs } } },
        },
        select: { id: true, testPlan: { select: { testCase: { select: { id: true, slug: true } } } } },
    });

    const latestByTestCase = new Map<string, string>();
    for (const gen of generations) {
        latestByTestCase.set(gen.testPlan.testCase.id, gen.id);
    }

    for (const [testCaseId, generationId] of latestByTestCase) {
        await db.affectedTest
            .update({
                where: { snapshotId_testCaseId: { snapshotId, testCaseId } },
                data: { generationId },
            })
            .catch((error) => {
                logger.warn("Failed to link AffectedTest to generation", { testCaseId, generationId, error });
            });
    }
}

async function reconcileTestCandidates(
    snapshotId: string,
    accepted: AcceptedCandidateLink[],
    logger: ReturnType<typeof rootLogger.child>,
): Promise<void> {
    if (accepted.length === 0) {
        logger.info("No new test candidates accepted");
        await db.testCandidate.updateMany({
            where: { snapshotId, status: "pending" },
            data: { status: "rejected" },
        });
        return;
    }

    const ids = accepted.map((a) => a.candidateId);
    const candidates = await db.testCandidate.findMany({
        where: { snapshotId, id: { in: ids } },
        select: { id: true },
    });
    const validIds = new Set(candidates.map((c) => c.id));

    const missing = accepted.filter((a) => !validIds.has(a.candidateId));
    if (missing.length > 0) {
        logger.warn("Accepted candidate ids not found in this snapshot", {
            missingCandidateIds: missing.map((m) => m.candidateId),
        });
    }

    await Promise.all(
        accepted
            .filter((a) => validIds.has(a.candidateId))
            .map((a) =>
                db.testCandidate
                    .update({
                        where: { id: a.candidateId },
                        data: { status: "accepted", acceptedTestCaseId: a.testCaseId },
                    })
                    .catch((error) => {
                        logger.warn("Failed to mark candidate accepted", {
                            candidateId: a.candidateId,
                            error,
                        });
                    }),
            ),
    );

    await db.testCandidate.updateMany({
        where: { snapshotId, status: "pending" },
        data: { status: "rejected" },
    });
}
