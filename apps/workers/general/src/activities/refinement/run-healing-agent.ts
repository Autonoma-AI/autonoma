import { MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import { type PrismaClient, db } from "@autonoma/db";
import {
    HealingAgent,
    type FailureRecord,
    type FlowSummary,
    type HealingAction,
    type PlanAuthoringInput,
    type ScenarioDetail,
    type ScenarioLookup,
    healingActionSchema,
} from "@autonoma/healing";
import { logger as rootLogger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import type {
    PersistedHealingAction,
    RunHealingAgentForRefinementInput,
    RunHealingAgentForRefinementOutput,
} from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";
import { withCodebaseForSnapshot } from "../../codebase/resolve";
import { uploadHealingConversation } from "./upload-conversation";

/**
 * Refinement-mode runner for HealingAgent. Clones the snapshot's codebase,
 * loads prior actions for this loop, runs the agent, persists each emitted
 * action as a RefinementAction row, and returns the persisted rows so the
 * workflow can dispatch apply* activities.
 */
export async function runHealingAgentForRefinement(
    input: RunHealingAgentForRefinementInput,
): Promise<RunHealingAgentForRefinementOutput> {
    const logger = rootLogger.child({
        name: "runHealingAgentForRefinement",
        snapshotId: input.snapshotId,
        iterationId: input.iterationId,
        iteration: input.iteration,
    });
    logger.info("Starting refinement healing run", {
        failureCount: input.failuresAtGeneration.length + input.failuresAtReplay.length,
    });

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
            db,
            snapshotId: input.snapshotId,
            organizationId: input.organizationId,
        });

        const priorActions = await loadPriorActions(input.iterationId);

        const failures = collectFailureRecords(input);

        const planAuthoring = await loadPlanAuthoringInput({
            db,
            applicationId: updater.applicationId,
            snapshotId: input.snapshotId,
        });

        const registry = new ModelRegistry({
            models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
        });
        const model = registry.getModel({ model: "flash", tag: "healing-refinement" });

        const result = await withCodebaseForSnapshot(input.snapshotId, {
            targetDirSeed: `healing-${input.iterationId}`,
            body: async (codebase) => {
                const agent = new HealingAgent({ model });
                return await agent.heal({
                    mode: "refinement",
                    iteration: input.iteration,
                    priorActions,
                    failures,
                    codebase,
                    planAuthoring,
                    snapshotId: input.snapshotId,
                    applicationId: updater.applicationId,
                    organizationId: input.organizationId,
                });
            },
        });

        const persisted = await persistActions(input.iterationId, result.actions, input);

        const conversationUrl = await uploadHealingConversation({
            storage: S3Storage.createFromEnv(),
            iterationId: input.iterationId,
            conversation: result.conversation,
            logger: logger.child({ name: "uploadHealingConversation", iterationId: input.iterationId }),
        });
        if (conversationUrl != null) {
            await db.refinementIteration.update({
                where: { id: input.iterationId },
                data: { healingConversationUrl: conversationUrl },
            });
        }

        logger.info("Refinement healing run finished", {
            actionCount: persisted.length,
            modelUsage: registry.modelUsage,
        });

        return { persistedActions: persisted, reasoning: result.reasoning };
    } finally {
        clearInterval(heartbeat);
    }
}

async function loadPriorActions(currentIterationId: string): Promise<HealingAction[]> {
    const current = await db.refinementIteration.findUniqueOrThrow({
        where: { id: currentIterationId },
        select: { loopId: true, number: true },
    });

    const priorRows = await db.refinementAction.findMany({
        where: { iteration: { loopId: current.loopId, number: { lt: current.number } } },
        select: { kind: true, payload: true },
        orderBy: { createdAt: "asc" },
    });

    return priorRows.map((row) => healingActionSchema.parse({ kind: row.kind, ...(row.payload as object) }));
}

function collectFailureRecords(input: RunHealingAgentForRefinementInput): FailureRecord[] {
    const fromGen: FailureRecord[] = input.failuresAtGeneration.map((f) => ({
        key: f.failureKey,
        source: "generation" as const,
        testCaseId: f.testCaseId,
        testCaseSlug: f.testCaseSlug,
        testCaseName: f.testCaseName,
        planId: f.planId,
        planPrompt: f.planPrompt,
        verdict: f.verdict,
        verdictKind: f.verdictKind,
        sourceId: f.sourceId,
        sourceStatus: f.sourceStatus,
        reviewReasoning: f.reviewReasoning,
    }));
    const fromRun: FailureRecord[] = input.failuresAtReplay.map((f) => ({
        key: f.failureKey,
        source: "replay" as const,
        testCaseId: f.testCaseId,
        testCaseSlug: f.testCaseSlug,
        testCaseName: f.testCaseName,
        planId: f.planId,
        planPrompt: f.planPrompt,
        verdict: f.verdict,
        verdictKind: f.verdictKind,
        sourceId: f.sourceId,
        sourceStatus: f.sourceStatus,
        reviewReasoning: f.reviewReasoning,
    }));
    return [...fromGen, ...fromRun];
}

async function persistActions(
    iterationId: string,
    actions: HealingAction[],
    input: RunHealingAgentForRefinementInput,
): Promise<PersistedHealingAction[]> {
    const persisted: PersistedHealingAction[] = [];

    for (const action of actions) {
        const reviewLink =
            action.kind === "report_bug" || action.kind === "report_engine_limitation"
                ? findReviewLinkFor(action.testCaseId, input)
                : undefined;

        const decorated = decorateActionWithReviewLink(action, reviewLink);

        const row = await db.refinementAction.create({
            data: {
                iterationId,
                kind: decorated.kind,
                planId: actionPlanId(decorated),
                testCaseId: actionTestCaseId(decorated),
                payload: actionPayload(decorated),
                reasoning: actionReasoning(decorated),
            },
            select: { id: true },
        });

        persisted.push({
            refinementActionId: row.id,
            action: decorated,
        });
    }

    return persisted;
}

function findReviewLinkFor(
    testCaseId: string,
    input: RunHealingAgentForRefinementInput,
): { generationReviewId: string } | { runReviewId: string } | undefined {
    const fromGen = input.failuresAtGeneration.find((f) => f.testCaseId === testCaseId);
    if (fromGen?.generationReviewId != null) return { generationReviewId: fromGen.generationReviewId };
    const fromRun = input.failuresAtReplay.find((f) => f.testCaseId === testCaseId);
    if (fromRun?.runReviewId != null) return { runReviewId: fromRun.runReviewId };
    return undefined;
}

type DecoratedAction = PersistedHealingAction["action"];

function decorateActionWithReviewLink(
    action: HealingAction,
    reviewLink: { generationReviewId: string } | { runReviewId: string } | undefined,
): DecoratedAction {
    if (action.kind === "report_bug") {
        if (reviewLink == null) {
            throw new Error(`report_bug for testCaseId=${action.testCaseId} has no source review to link`);
        }
        return { ...action, reviewLink };
    }
    if (action.kind === "report_engine_limitation") {
        if (reviewLink == null) {
            throw new Error(
                `report_engine_limitation for testCaseId=${action.testCaseId} has no source review to link`,
            );
        }
        return { ...action, reviewLink };
    }
    return action;
}

function actionPlanId(a: DecoratedAction): string | undefined {
    return a.kind === "update_plan" ? a.planId : undefined;
}

function actionTestCaseId(a: DecoratedAction): string | undefined {
    if (a.kind === "add_test") return undefined;
    return a.testCaseId;
}

function actionReasoning(a: DecoratedAction): string {
    return a.kind === "remove_test" ? a.reason : a.reasoning;
}

function actionPayload(a: DecoratedAction): Record<string, unknown> {
    const { kind: _kind, ...rest } = a;
    return rest as unknown as Record<string, unknown>;
}

async function loadPlanAuthoringInput({
    db,
    applicationId,
    snapshotId,
}: {
    db: PrismaClient;
    applicationId: string;
    snapshotId: string;
}): Promise<PlanAuthoringInput> {
    const [scenarios, flows, application] = await Promise.all([
        loadScenarioLookup(db, applicationId),
        loadFlowSummaries(db, applicationId, snapshotId),
        db.application.findUniqueOrThrow({
            where: { id: applicationId },
            select: { testScopeGuidelines: true },
        }),
    ]);
    return {
        scenarios,
        flows,
        testScopeGuidelines: application.testScopeGuidelines ?? undefined,
    };
}

async function loadScenarioLookup(db: PrismaClient, applicationId: string): Promise<ScenarioLookup> {
    const scenarios = await db.scenario.findMany({
        where: { applicationId, isDisabled: false },
        select: {
            id: true,
            name: true,
            description: true,
            activeRecipeVersion: {
                select: { fingerprint: true, fixtureJson: true, validationStatus: true },
            },
            instances: {
                where: { status: "UP_SUCCESS" },
                orderBy: { upAt: "desc" },
                take: 3,
                select: { metadata: true },
            },
        },
    });

    const details: ScenarioDetail[] = scenarios.map((s) => {
        const sample = s.instances.find((i) => i.metadata != null);
        return {
            id: s.id,
            name: s.name,
            description: s.description ?? undefined,
            activeRecipe:
                s.activeRecipeVersion != null
                    ? {
                          fingerprint: s.activeRecipeVersion.fingerprint,
                          fixtureJson: s.activeRecipeVersion.fixtureJson,
                          validationStatus: s.activeRecipeVersion.validationStatus,
                      }
                    : undefined,
            sampleMetadata: sample?.metadata ?? undefined,
        };
    });

    const byId = new Map(details.map((d) => [d.id, d]));

    return {
        listScenarios: () => details.map((d) => ({ id: d.id, name: d.name, description: d.description })),
        getScenario: (id) => byId.get(id),
        hasScenario: (id) => byId.has(id),
    };
}

async function loadFlowSummaries(db: PrismaClient, applicationId: string, snapshotId: string): Promise<FlowSummary[]> {
    const folders = await db.folder.findMany({
        where: { applicationId },
        select: { id: true, name: true, description: true },
    });

    const assignments = await db.testCaseAssignment.findMany({
        where: { snapshotId },
        select: { testCase: { select: { folderId: true } } },
    });

    const counts = new Map<string, number>();
    for (const a of assignments) {
        counts.set(a.testCase.folderId, (counts.get(a.testCase.folderId) ?? 0) + 1);
    }

    return folders.map((f) => ({
        id: f.id,
        name: f.name,
        description: f.description ?? undefined,
        testCount: counts.get(f.id) ?? 0,
    }));
}
