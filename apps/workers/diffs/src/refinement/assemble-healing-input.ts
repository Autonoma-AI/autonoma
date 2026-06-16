import { type PrismaClient, db } from "@autonoma/db";
import {
    type FailureRecord,
    FlowIndex,
    type FlowSummary,
    type HealingAction,
    type HealingFailureSubject,
    type HealingInput,
    type HealingSubjectContext,
    type PlanAuthoringInput,
    ScenarioIndex,
    healingActionSchema,
    loadFlows,
    mapTestSuiteToContext,
} from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { fetchTestSuiteInfo } from "@autonoma/test-updates";
import type { GenerationOutcomeFailure, RunOutcomeFailure } from "@autonoma/workflow/activities";
import { DiffJobContextLoader } from "../review/diff-job-context-loader";

/** Everything {@link HealingAgent} needs except the on-disk codebase clone. */
export type HealingInputWithoutCodebase = Omit<HealingInput, "codebase">;

export interface AssembleHealingInputParams {
    iterationId: string;
    iterationNumber: number;
    snapshotId: string;
    failuresAtGeneration: GenerationOutcomeFailure[];
    failuresAtReplay: RunOutcomeFailure[];
}

export interface AssembledHealingInput {
    /** Ready to spread into `HealingAgent.run` once the caller adds a `codebase`. */
    agentInput: HealingInputWithoutCodebase;
    /** Convenience meta the runner uses for downstream wiring (TestSuiteUpdater, persistence). */
    meta: {
        snapshotId: string;
        organizationId: string;
        applicationId: string;
        iterationNumber: number;
    };
}

/**
 * Assemble the full {@link HealingInput} (minus the codebase) from already
 * bucketed iteration outcomes.
 *
 * This is the single shared loader used by both the production refinement
 * runner and the eval-capture utility:
 *
 *  - The runner forwards its activity input (analyzeResults already bucketed
 *    failures upstream) straight into the live agent.
 *  - Capture buckets the iteration's outcomes via {@link bucketIterationOutcomes}
 *    first, then feeds the result here; the resulting `agentInput` is frozen
 *    to disk for the eval to rehydrate later.
 *
 * The per-failure diff-job context (the full per-test refinement lineage, the
 * snapshot's change facts, and each failing subject's materialized scenario
 * data) plus the snapshot's application/organization are sourced from the shared
 * {@link DiffJobContextLoader} so healing consumes exactly what the reviewers and
 * resolution do. The remaining side-inputs (prior actions, plan-authoring
 * scenarios/flows/guidelines, reportable review links) are healing-specific and
 * assembled here.
 *
 * Loading scenarios + flows + scope guidelines reads the application's
 * *current* state. Eval cases captured by id are therefore snapshots of what
 * the agent would see at capture time, not literally what the live iteration
 * saw - acceptable for the eval contract (priorActions and failures, the
 * inputs the rubric grades against, are reconstructed exactly).
 */
export async function assembleHealingInput(params: AssembleHealingInputParams): Promise<AssembledHealingInput> {
    const logger = rootLogger.child({ name: "assembleHealingInput" });
    const { iterationId, iterationNumber, snapshotId, failuresAtGeneration, failuresAtReplay } = params;

    logger.info("Loading healing assembly inputs", {
        extra: {
            iterationId,
            iterationNumber,
            snapshotId,
            failureCount: failuresAtGeneration.length + failuresAtReplay.length,
        },
    });

    const baseFailures = collectFailureRecords(failuresAtGeneration, failuresAtReplay);

    // The diff-job context (per-failure lineage + scenario + affected facts, and
    // the snapshot's change facts + application/org) comes from the shared loader.
    // Prior actions and the suite (for the suite-browsing tools + add_test folder
    // validation) are independent of it, so gather them concurrently.
    const [diffJobContext, priorActions, suiteInfo] = await Promise.all([
        new DiffJobContextLoader(db).loadHealingContext({
            snapshotId,
            subjects: baseFailures.map(toHealingSubject),
        }),
        loadPriorActions(iterationId),
        fetchTestSuiteInfo(db, snapshotId),
    ]);

    const { applicationId, organizationId } = diffJobContext;
    const { existingTests } = mapTestSuiteToContext(suiteInfo);

    const [planAuthoring, flows] = await Promise.all([
        loadPlanAuthoringInput({ db, applicationId, snapshotId }),
        loadFlows(db, applicationId, suiteInfo),
    ]);

    const failures = mergeDiffJobContext(baseFailures, diffJobContext.subjects);

    const agentInput: HealingInputWithoutCodebase = {
        iteration: iterationNumber,
        priorActions,
        failures,
        // No candidates on the refinement-only path; the diffs analysis fold
        // (a later slice) seeds the first turn's candidates. With none, add_test
        // is dormant and the result tool's candidate clause is vacuous.
        candidates: [],
        flowIndex: new FlowIndex(flows),
        existingTests,
        planAuthoring,
        snapshotId,
        applicationId,
        organizationId,
        change: diffJobContext.change,
        analysisReasoning: diffJobContext.analysisReasoning,
    };

    return { agentInput, meta: { snapshotId, organizationId, applicationId, iterationNumber } };
}

/** Project a bucketed {@link FailureRecord} into the lean subject the loader gathers context for. */
function toHealingSubject(failure: FailureRecord): HealingFailureSubject {
    return {
        failureKey: failure.key,
        source: failure.source,
        sourceId: failure.sourceId,
        planId: failure.planId,
        testCaseId: failure.testCaseId,
    };
}

/**
 * Merge the loader's per-subject diff-job context (lineage, scenario, affected
 * facts) back onto each {@link FailureRecord} by `failureKey`. A failure with no
 * gathered context (none matched its key) passes through unchanged.
 */
function mergeDiffJobContext(failures: FailureRecord[], subjectContexts: HealingSubjectContext[]): FailureRecord[] {
    const contextByKey = new Map(subjectContexts.map((context) => [context.failureKey, context]));

    return failures.map((failure) => {
        const context = contextByKey.get(failure.key);
        if (context == null) return failure;

        // Override-only-when-present: the gathered context wins, but an optional
        // field it didn't resolve keeps whatever the base failure already carried.
        return {
            ...failure,
            affectedReason: context.affectedReason ?? failure.affectedReason,
            affectedReasoning: context.affectedReasoning ?? failure.affectedReasoning,
            lineage: context.lineage,
            scenario: context.scenario ?? failure.scenario,
        };
    });
}

/** Read every action emitted by *earlier* iterations of the same loop, in emission order. */
export async function loadPriorActions(currentIterationId: string): Promise<HealingAction[]> {
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

/**
 * Project bucketed gen/run failures into the {@link FailureRecord} shape the
 * agent reads. Each record carries its own source review link (deterministic
 * failure metadata): a generation failure links to its generation review, a
 * replay failure to its run review. A failure with no review id carries no
 * link and so cannot be the target of a report action.
 */
export function collectFailureRecords(
    failuresAtGeneration: GenerationOutcomeFailure[],
    failuresAtReplay: RunOutcomeFailure[],
): FailureRecord[] {
    const fromGen: FailureRecord[] = failuresAtGeneration.map((f) => ({
        key: f.failureKey,
        source: "generation",
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
        lineage: [],
        reviewLink: f.generationReviewId != null ? { generationReviewId: f.generationReviewId } : undefined,
    }));
    const fromRun: FailureRecord[] = failuresAtReplay.map((f) => ({
        key: f.failureKey,
        source: "replay",
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
        lineage: [],
        reviewLink: f.runReviewId != null ? { runReviewId: f.runReviewId } : undefined,
    }));
    return [...fromGen, ...fromRun];
}

export async function loadPlanAuthoringInput({
    db,
    applicationId,
    snapshotId,
}: {
    db: PrismaClient;
    applicationId: string;
    snapshotId: string;
}): Promise<PlanAuthoringInput> {
    const [scenarios, flows, application] = await Promise.all([
        loadScenarioIndex(db, applicationId),
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

async function loadScenarioIndex(db: PrismaClient, applicationId: string): Promise<ScenarioIndex> {
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

    const details = scenarios.map((s) => {
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

    return new ScenarioIndex(details);
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
