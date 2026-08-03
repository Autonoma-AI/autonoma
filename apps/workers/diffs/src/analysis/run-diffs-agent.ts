import type { AgentRunResult } from "@autonoma/ai";
import { db } from "@autonoma/db";
import {
    type Codebase,
    DiffsAgent,
    type DiffsAgentInput,
    type DiffsAgentResult,
    type ModelSession,
    openModelSession,
    summarizeSessionCost,
} from "@autonoma/diffs";
import { persistInvestigationCosts } from "@autonoma/diffs/analysis";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { ModelMessage } from "ai";
import { getStorage } from "../services";
import { uploadConversation } from "../upload-conversation";

interface RunDiffsAgentParams {
    /** The run's snapshot - what the conversation object and the cost records are attributed to. */
    snapshotId: string;
    /** Everything the DiffsAgent needs except the codebase clone (which the activity owns). */
    input: Omit<DiffsAgentInput, "codebase">;
    /** The on-disk clone, acquired by the activity via `withCodebaseForSnapshot`. */
    codebase: Codebase;
}

export interface DiffsAgentRun extends AgentRunResult<DiffsAgentResult> {
    /** S3 URL of the uploaded conversation, or undefined when the upload was skipped or failed. */
    conversationUrl?: string;
}

/**
 * Constructs a {@link DiffsAgent} over a metered {@link openModelSession}, invokes {@link DiffsAgent.run}, and
 * records what the stage did: the full conversation to S3 and the session's spend to `ai_cost_record` under the
 * `analysis-impact` tag. Both recordings are best-effort - the selection this returns is the run's only
 * irreplaceable output, so neither an S3 nor a DB failure may discard it.
 */
export async function runDiffsAgent({ snapshotId, input, codebase }: RunDiffsAgentParams): Promise<DiffsAgentRun> {
    const logger = rootLogger.child({ name: "runDiffsAgent" });
    const session = openModelSession();
    const model = session.getModel({ model: "smart-visual", tag: "analysis-impact" });

    const agent = new DiffsAgent({ model });

    const { result, conversation } = await agent.run({ ...input, codebase });

    logger.info("Diffs analysis model cost", { extra: summarizeSessionCost(session.costCollector) });

    logger.info("Diffs analysis complete", {
        extra: {
            affectedTests: result.affectedTests.length,
            createdTests: result.createdTests.length,
            reasoning: result.reasoning.slice(0, 500),
        },
    });

    const conversationUrl = await recordRunArtifacts({ snapshotId, session, conversation, logger });

    return { result, conversation, conversationUrl };
}

/**
 * Persist the stage's audit trail - the transcript that answers what the agent read and why it selected what it
 * did, and the spend that answers what asking cost. Neither failure propagates.
 */
async function recordRunArtifacts({
    snapshotId,
    session,
    conversation,
    logger,
}: {
    snapshotId: string;
    session: ModelSession;
    conversation: ModelMessage[];
    logger: Logger;
}): Promise<string | undefined> {
    const [conversationUrl] = await Promise.all([
        uploadAnalysisConversation({ snapshotId, conversation, logger }),
        persistInvestigationCosts(db, snapshotId, session.costCollector, logger).catch((error) =>
            logger.warn("Failed to persist the analysis costs", { err: error }),
        ),
    ]);
    return conversationUrl;
}

/**
 * Upload the transcript under the `analysis` phase key. Resolving the storage client is inside the try - a
 * misconfigured worker must degrade to a missing transcript, not a failed selection.
 */
async function uploadAnalysisConversation({
    snapshotId,
    conversation,
    logger,
}: {
    snapshotId: string;
    conversation: ModelMessage[];
    logger: Logger;
}): Promise<string | undefined> {
    try {
        return await uploadConversation({
            storage: getStorage(),
            snapshotId,
            phase: "analysis",
            conversation,
            logger: logger.child({ name: "uploadConversation" }),
        });
    } catch (error) {
        logger.warn("Failed to upload the analysis conversation", { err: error });
        return undefined;
    }
}
