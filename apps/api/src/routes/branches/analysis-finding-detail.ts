import type { AnalysisStore, FindingDetailClassification, FindingDetailRecord } from "@autonoma/analysis";
import type { GenerationStatus, Prisma, PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import type { TestSuiteStore } from "@autonoma/test-suite";
import {
    type AnalysisSuiteChangeKind,
    type AnalysisTestOrigin,
    type InvestigationEvidence,
    type OverlayPoint,
    analysisTestOriginSchema,
    getStepOverlayPoints,
    investigationEvidenceSchema,
    isTerminalGenerationStatus,
} from "@autonoma/types";
import { findLatestWorkflowByGenerationId } from "@autonoma/workflow";
import { z } from "zod";
import { type ScenarioDebugPayload, buildScenarioDebug } from "../scenario-debug";

const MEDIA_TTL_SECONDS = 60 * 60;

/** One live-persisted step of the generation the drawer is showing, with its media signed. */
export interface AnalysisFindingDetailStep {
    order: number;
    interaction: string;
    params: Prisma.JsonValue;
    status: string;
    output?: Prisma.JsonValue;
    error?: string;
    errorName?: string;
    screenshotBefore?: string;
    screenshotAfter?: string;
    /** Where the agent acted, in the screenshot's own pixel space. */
    overlayPoints?: OverlayPoint[];
}

/** One entry of the finding's iteration history - enough for the drawer's attempt toggle. */
export interface AnalysisFindingDetailIteration {
    number: number;
    category: string;
    headline: string;
    createdAt: Date;
    /** Signed classifier-conversation URL; admin-only, absent otherwise. */
    conversationUrl?: string;
}

/** The selected iteration's verdict story - the drawer's summary tab. */
export interface AnalysisFindingDetailClassification {
    number: number;
    category: string;
    confidence?: string;
    headline: string;
    createdAt: Date;
    expectedBehavior?: string;
    actualBehavior?: string;
    whatHappened?: string;
    planMismatchNote?: string;
    invalidTestNote?: string;
    observedAppIssues?: string;
    remediation?: string;
    rootCause?: string;
    falsePositiveRisk?: string;
    evidence: InvestigationEvidence[];
    keyScreenshotUrl?: string;
    error?: string;
}

/** The generation behind the selected iteration (or the live latest, pre-classification), media signed. */
export interface AnalysisFindingDetailGeneration {
    id: string;
    status: GenerationStatus;
    startedAt: Date;
    /** Approximated by the row's last write; absent while the generation is still running. */
    completedAt?: Date;
    videoUrl?: string;
    optimizedVideoUrl?: string;
    steps: AnalysisFindingDetailStep[];
    /** Why the generation failed, when it did at the system level (scenario setup / engine error) - the drawer
     * renders these as a critical panel, the same way the generation page does, for runs that never reached the
     * app so there is no video, no steps, and no verdict story to show. */
    failure?: PrismaJson.GenerationFailure;
    /** Admin-only fields, absent otherwise. */
    temporalWorkflow?: { workflowId: string; runId: string };
    conversationUrl?: string;
    debug?: ScenarioDebugPayload;
}

/**
 * One finding in full for the checkpoint drawer: identity, iteration history, the selected iteration's verdict
 * story, the generation behind it (live steps included), and the plan with the PR's change to it.
 */
export interface AnalysisFindingDetailView {
    findingId: string;
    snapshotId: string;
    testCase: { id: string; name: string; slug: string; description?: string };
    origin?: AnalysisTestOrigin;
    selfHealed: boolean;
    contained: boolean;
    /** What this PR did to the test's plan; absent when the PR left it untouched. */
    change?: AnalysisSuiteChangeKind;
    /** Oldest first. Empty until the first classification lands. */
    iterations: AnalysisFindingDetailIteration[];
    /** The selected iteration (the current one unless `iteration` picked an earlier attempt); absent while the
     * test is unjudged. */
    classification?: AnalysisFindingDetailClassification;
    generation?: AnalysisFindingDetailGeneration;
    /** The plan the drawer's plan tab shows: the selected generation's pinned plan, falling back to the
     * snapshot's assignment for a test that has not run yet. */
    plan: string;
    /** The plan before this PR changed it; present only when `change` is `edited`. */
    previousPlan?: string;
}

export interface AnalysisFindingDetailDeps {
    db: PrismaClient;
    storage: StorageProvider;
    suite: TestSuiteStore;
    analysisStore: AnalysisStore;
    logger: Logger;
}

export interface AnalysisFindingDetailInput {
    findingId: string;
    organizationId: string;
    /** Selects a self-heal iteration by its 1-based number; defaults to the current classification. */
    iteration?: number;
    isAdmin: boolean;
}

/** Assemble the drawer's view of one finding. Undefined for an unknown/foreign finding or an unknown iteration. */
export async function loadAnalysisFindingDetail(
    deps: AnalysisFindingDetailDeps,
    input: AnalysisFindingDetailInput,
): Promise<AnalysisFindingDetailView | undefined> {
    const record = await deps.analysisStore.findingDetail(input.findingId, {
        organizationId: input.organizationId,
    });
    if (record == null) return undefined;

    const selected = selectClassification(record, input.iteration);
    if (input.iteration != null && selected == null) return undefined;

    const generationRow = await loadGeneration(deps.db, record, selected);
    const suiteChange = await findSuiteChange(deps, record);

    const [iterations, classification, generation] = await Promise.all([
        signIterations(deps.storage, record.classifications, input.isAdmin),
        selected != null ? signClassification(deps.storage, selected) : undefined,
        generationRow != null ? buildGeneration(deps, generationRow, input.isAdmin) : undefined,
    ]);

    return {
        findingId: record.findingId,
        snapshotId: record.snapshotId,
        testCase: record.testCase,
        origin: analysisTestOriginSchema.safeParse(record.origin).data,
        selfHealed: record.classifications.length > 1,
        contained: record.failure != null,
        change: suiteChange?.kind,
        iterations,
        classification,
        generation,
        plan: generationRow?.testPlan.prompt ?? suiteChange?.plan ?? (await loadAssignedPlan(deps.db, record)),
        previousPlan: suiteChange?.kind === "edited" ? suiteChange.previousPlan : undefined,
    };
}

function selectClassification(
    record: FindingDetailRecord,
    iteration: number | undefined,
): FindingDetailClassification | undefined {
    if (iteration != null) return record.classifications.find((entry) => entry.number === iteration);
    return record.classifications.find((entry) => entry.id === record.currentClassificationId);
}

const generationSelect = {
    id: true,
    status: true,
    failure: true,
    createdAt: true,
    updatedAt: true,
    videoUrl: true,
    optimizedVideoUrl: true,
    conversationUrl: true,
    testPlan: { select: { prompt: true, scenarioName: true } },
    attempts: {
        orderBy: { order: "asc" },
        select: {
            order: true,
            interaction: true,
            params: true,
            status: true,
            output: true,
            error: true,
            errorName: true,
            screenshotBefore: true,
            screenshotAfter: true,
        },
    },
    scenarioInstance: {
        select: {
            id: true,
            status: true,
            upAt: true,
            downAt: true,
            lastError: true,
            auth: true,
            resolvedVariables: true,
            scenario: { select: { id: true, name: true } },
            deployment: { select: { webhookUrl: true, webDeployment: { select: { url: true } } } },
        },
    },
    snapshot: {
        select: {
            id: true,
            status: true,
            headSha: true,
            branch: { select: { id: true, name: true, prInfo: { select: { prNumber: true } } } },
        },
    },
} satisfies Prisma.TestGenerationSelect;

type GenerationRow = Prisma.TestGenerationGetPayload<{ select: typeof generationSelect }>;

/**
 * The generation the drawer shows: the selected classification's pinned one, or - while the test is unjudged -
 * the latest live generation for the test in this snapshot.
 */
async function loadGeneration(
    db: PrismaClient,
    record: FindingDetailRecord,
    selected: FindingDetailClassification | undefined,
): Promise<GenerationRow | undefined> {
    if (selected != null) {
        const row = await db.testGeneration.findUnique({
            where: { id: selected.generationId },
            select: generationSelect,
        });
        return row ?? undefined;
    }
    const row = await db.testGeneration.findFirst({
        where: {
            snapshotId: record.snapshotId,
            testPlan: { testCaseId: record.testCase.id },
        },
        // Same total order as the run view's latest-generation pick, so the drawer and the row never disagree
        // about which generation is "the" latest.
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: generationSelect,
    });
    return row ?? undefined;
}

interface ResolvedSuiteChange {
    kind: AnalysisSuiteChangeKind;
    plan?: string;
    previousPlan?: string;
}

async function findSuiteChange(
    deps: AnalysisFindingDetailDeps,
    record: FindingDetailRecord,
): Promise<ResolvedSuiteChange | undefined> {
    const changes = await deps.suite.changesSince(record.snapshotId);
    const change = changes.find((candidate) => candidate.testCaseId === record.testCase.id);
    if (change == null) return undefined;
    switch (change.type) {
        case "added":
            return { kind: "created", plan: change.plan };
        case "updated":
            return { kind: "edited", plan: change.plan, previousPlan: change.previousPlan };
        case "removed":
            return { kind: "removed", plan: change.previousPlan };
    }
}

/** The plan assigned to the test in this snapshot - the fallback for a selected test that has not run yet. */
async function loadAssignedPlan(db: PrismaClient, record: FindingDetailRecord): Promise<string> {
    const assignment = await db.testCaseAssignment.findUnique({
        where: { snapshotId_testCaseId: { snapshotId: record.snapshotId, testCaseId: record.testCase.id } },
        select: { plan: { select: { prompt: true } } },
    });
    return assignment?.plan?.prompt ?? "";
}

async function signIterations(
    storage: StorageProvider,
    classifications: FindingDetailClassification[],
    isAdmin: boolean,
): Promise<AnalysisFindingDetailIteration[]> {
    return Promise.all(
        classifications.map(async (entry) => ({
            number: entry.number,
            category: entry.category,
            headline: entry.headline,
            createdAt: entry.createdAt,
            conversationUrl:
                isAdmin && entry.conversationUrl != null
                    ? await storage.getSignedUrl(entry.conversationUrl, MEDIA_TTL_SECONDS)
                    : undefined,
        })),
    );
}

async function signClassification(
    storage: StorageProvider,
    selected: FindingDetailClassification,
): Promise<AnalysisFindingDetailClassification> {
    return {
        number: selected.number,
        category: selected.category,
        confidence: selected.confidence,
        headline: selected.headline,
        createdAt: selected.createdAt,
        expectedBehavior: selected.expectedBehavior,
        actualBehavior: selected.actualBehavior,
        whatHappened: selected.whatHappened,
        planMismatchNote: selected.planMismatchNote,
        invalidTestNote: selected.invalidTestNote,
        observedAppIssues: selected.observedAppIssues,
        remediation: selected.remediation,
        rootCause: selected.rootCause,
        falsePositiveRisk: selected.falsePositiveRisk,
        evidence: parseEvidence(selected.evidence),
        keyScreenshotUrl:
            selected.screenshotKey != null
                ? await storage.getSignedUrl(selected.screenshotKey, MEDIA_TTL_SECONDS)
                : undefined,
        error: selected.error,
    };
}

const evidenceListSchema = z.array(investigationEvidenceSchema);

function parseEvidence(evidence: PrismaJson.InvestigationEvidenceList | undefined): InvestigationEvidence[] {
    return evidenceListSchema.safeParse(evidence).data ?? [];
}

async function buildGeneration(
    deps: AnalysisFindingDetailDeps,
    row: GenerationRow,
    isAdmin: boolean,
): Promise<AnalysisFindingDetailGeneration> {
    const webhookCallsPromise =
        isAdmin && row.scenarioInstance != null
            ? deps.db.webhookCall.findMany({
                  where: { instanceId: row.scenarioInstance.id },
                  orderBy: { createdAt: "desc" },
              })
            : Promise.resolve([]);

    const [steps, videoUrl, optimizedVideoUrl, conversationUrl, temporalWorkflow, webhookCalls] = await Promise.all([
        Promise.all(row.attempts.map((attempt) => signStep(deps.storage, attempt))),
        signIfPresent(deps.storage, row.videoUrl),
        signIfPresent(deps.storage, row.optimizedVideoUrl),
        isAdmin ? signIfPresent(deps.storage, row.conversationUrl) : Promise.resolve(undefined),
        isAdmin ? resolveTemporalWorkflow(deps.logger, row.id) : Promise.resolve(undefined),
        webhookCallsPromise,
    ]);

    return {
        id: row.id,
        status: row.status,
        startedAt: row.createdAt,
        completedAt: isTerminalGenerationStatus(row.status) ? row.updatedAt : undefined,
        videoUrl,
        optimizedVideoUrl,
        steps,
        failure: row.failure ?? undefined,
        temporalWorkflow,
        conversationUrl,
        debug: isAdmin
            ? buildScenarioDebug({
                  scenarioInstance: row.scenarioInstance,
                  snapshot: row.snapshot,
                  webhookCalls,
                  scenarioName: row.testPlan.scenarioName,
              })
            : undefined,
    };
}

async function signStep(
    storage: StorageProvider,
    attempt: GenerationRow["attempts"][number],
): Promise<AnalysisFindingDetailStep> {
    const [screenshotBefore, screenshotAfter] = await Promise.all([
        signIfPresent(storage, attempt.screenshotBefore),
        signIfPresent(storage, attempt.screenshotAfter),
    ]);
    const overlayPoints = getStepOverlayPoints(attempt.output);
    return {
        order: attempt.order,
        interaction: attempt.interaction,
        params: attempt.params,
        status: attempt.status,
        output: attempt.output ?? undefined,
        error: attempt.error ?? undefined,
        errorName: attempt.errorName ?? undefined,
        screenshotBefore,
        screenshotAfter,
        overlayPoints: overlayPoints.length > 0 ? overlayPoints : undefined,
    };
}

async function signIfPresent(storage: StorageProvider, key: string | null): Promise<string | undefined> {
    if (key == null) return undefined;
    return storage.getSignedUrl(key, MEDIA_TTL_SECONDS);
}

async function resolveTemporalWorkflow(
    logger: Logger,
    generationId: string,
): Promise<{ workflowId: string; runId: string } | undefined> {
    try {
        const workflow = await findLatestWorkflowByGenerationId(generationId);
        return workflow != null ? { workflowId: workflow.workflowId, runId: workflow.runId } : undefined;
    } catch (error) {
        logger.warn("Could not resolve Temporal workflow for generation", { extra: { generationId }, err: error });
        return undefined;
    }
}
