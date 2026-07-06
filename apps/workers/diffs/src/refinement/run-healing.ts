import { db } from "@autonoma/db";
import {
    type Codebase,
    HealingAgent,
    type HealingAction,
    openModelSession,
    StorageEvidenceLoader,
    summarizeSessionCost,
} from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import type {
    PersistedHealingAction,
    RunHealingAgentForRefinementInput,
    RunHealingAgentForRefinementOutput,
} from "@autonoma/workflow/activities";
import { assembleHealingInput } from "./assemble-healing-input";
import { uploadHealingConversation } from "./upload-conversation";

/**
 * Orchestrates a single refinement-mode HealingAgent run inside a codebase
 * already acquired by the activity. Opens a model session, assembles the agent
 * input via the shared {@link assembleHealingInput} loader (which also powers
 * eval capture), runs the agent, persists each emitted action as a
 * RefinementAction row, uploads the conversation, and logs aggregated cost.
 * Returns the persisted rows so the workflow can dispatch apply* activities.
 */
export async function runRefinementHealing(
    input: RunHealingAgentForRefinementInput,
    codebase: Codebase,
): Promise<RunHealingAgentForRefinementOutput> {
    const logger = rootLogger.child({ name: "runRefinementHealing" });
    logger.info("Running refinement healing agent", {
        extra: {
            iterationNumber: input.iteration,
            failureCount: input.failuresAtGeneration.length + input.failuresAtReplay.length,
        },
    });

    // Defense-in-depth: throws SnapshotNotPendingError if the snapshot has been
    // finalized / cancelled between activity scheduling and execution, or if
    // input.organizationId doesn't own it. Without this guard a replayed or
    // mis-routed activity could persist RefinementAction rows + a conversation
    // URL onto a terminal iteration context. Returned updater is discarded -
    // assembleHealingInput is the source of truth for the agent input.
    await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId: input.snapshotId,
        organizationId: input.organizationId,
    });

    const { agentInput } = await assembleHealingInput({
        iterationId: input.iterationId,
        iterationNumber: input.iteration,
        maxIterations: input.maxIterations,
        snapshotId: input.snapshotId,
        failuresAtGeneration: input.failuresAtGeneration,
        failuresAtReplay: input.failuresAtReplay,
    });

    const session = openModelSession();
    const model = session.getModel({ model: "smart-visual", tag: "healing-refinement" });

    // Backs fetch_step_evidence: rehydrates a step screenshot's bytes from its S3
    // key at tool-call time, so screenshots are pulled on demand rather than eagerly.
    const screenshotLoader = new StorageEvidenceLoader(S3Storage.createFromEnv());

    const agent = new HealingAgent({ model });
    const { result, conversation } = await agent.run({ ...agentInput, codebase, screenshotLoader });

    const persisted = await persistActions(input.iterationId, result.actions);

    const conversationUrl = await uploadHealingConversation({
        storage: S3Storage.createFromEnv(),
        iterationId: input.iterationId,
        conversation,
        logger: logger.child({ name: "uploadHealingConversation" }),
    });
    // Persist the agent's summary reasoning unconditionally; an `undefined`
    // conversationUrl (upload skipped or failed) leaves that column untouched.
    await db.refinementIteration.update({
        where: { id: input.iterationId },
        data: { reasoning: result.reasoning, healingConversationUrl: conversationUrl },
    });

    logger.info("Refinement healing cost", { extra: summarizeSessionCost(session.costCollector) });

    logger.info("Refinement healing run finished", { extra: { actionCount: persisted.length } });

    return {
        persistedActions: persisted,
        reasoning: result.reasoning,
    };
}

/**
 * Persists every per-failure action as a RefinementAction row, returning each
 * with its row id so the workflow can dispatch the matching apply* activity.
 */
async function persistActions(iterationId: string, actions: HealingAction[]): Promise<PersistedHealingAction[]> {
    const persisted: PersistedHealingAction[] = [];

    for (const action of actions) {
        const row = await db.refinementAction.create({
            data: {
                iterationId,
                kind: action.kind,
                planId: actionPlanId(action),
                testCaseId: action.testCaseId,
                payload: actionPayload(action),
                reasoning: actionReasoning(action),
            },
            select: { id: true },
        });

        persisted.push({ refinementActionId: row.id, action });
    }

    return persisted;
}

function actionPlanId(a: HealingAction): string | undefined {
    return a.kind === "update_plan" ? a.planId : undefined;
}

function actionReasoning(a: HealingAction): string {
    return a.kind === "remove_test" ? a.reason : a.reasoning;
}

function actionPayload(a: HealingAction): Record<string, unknown> {
    const { kind: _kind, ...rest } = a;
    return rest as unknown as Record<string, unknown>;
}
