import type { Prisma } from "@autonoma/db";
import {
    type GenerationReviewVerdict,
    type GenerationStatus,
    type PrismaClient,
    type RunReviewVerdict,
    type RunStatus,
} from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { healingActionSchema, type HealingAction } from "@autonoma/types";

interface TestCaseLite {
    id: string;
    name: string;
    slug: string;
}

interface OutcomeValidated {
    planId: string;
    testCase: TestCaseLite;
    generationId: string;
    runId: string;
}

interface OutcomeFailedAtGeneration {
    planId: string;
    testCase: TestCaseLite;
    generationId: string;
    generationStatus: GenerationStatus;
    verdictKind?: GenerationReviewVerdict;
    reviewReasoning?: string;
}

interface OutcomeFailedAtReplay {
    planId: string;
    testCase: TestCaseLite;
    runId: string;
    runStatus: RunStatus;
    verdictKind?: RunReviewVerdict;
    reviewReasoning?: string;
}

interface OutcomeAwaiting {
    planId: string;
    testCase: TestCaseLite;
}

export interface RefinementIterationOutcomes {
    validated: OutcomeValidated[];
    failedAtGeneration: OutcomeFailedAtGeneration[];
    failedAtReplay: OutcomeFailedAtReplay[];
    awaiting: OutcomeAwaiting[];
}

export interface RefinementActionView {
    id: string;
    kind: HealingAction["kind"];
    payload: HealingAction;
    reasoning: string;
    appliedAt?: Date;
    createdAt: Date;
    plan?: { id: string; testCaseId: string };
    testCase?: TestCaseLite;
}

export interface RefinementIterationView {
    id: string;
    number: number;
    status: "pending" | "running" | "completed";
    startedAt: Date;
    finishedAt?: Date;
    inputs: Array<{ planId: string; testCase: TestCaseLite }>;
    outcomes: RefinementIterationOutcomes;
    actions: RefinementActionView[];
}

export interface RefinementLoopView {
    id: string;
    triggeredBy: "onboarding" | "diffs";
    status: "running" | "converged" | "max_iterations" | "error";
    startedAt: Date;
    finishedAt?: Date;
    iterations: RefinementIterationView[];
}

const loopSelect = {
    id: true,
    triggeredBy: true,
    status: true,
    startedAt: true,
    finishedAt: true,
    iterations: {
        orderBy: { number: "asc" },
        select: {
            id: true,
            number: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            inputs: {
                select: {
                    planId: true,
                    plan: { select: { testCase: { select: { id: true, name: true, slug: true } } } },
                },
            },
            actions: {
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    kind: true,
                    planId: true,
                    testCaseId: true,
                    payload: true,
                    reasoning: true,
                    appliedAt: true,
                    createdAt: true,
                },
            },
        },
    },
} satisfies Prisma.RefinementLoopSelect;

type LoopRow = Prisma.RefinementLoopGetPayload<{ select: typeof loopSelect }>;
type IterationRow = LoopRow["iterations"][number];
type ActionRow = IterationRow["actions"][number];

export interface RefinementGenerationRow {
    id: string;
    testPlanId: string;
    status: GenerationStatus;
    createdAt: Date;
    generationReview: { verdict: GenerationReviewVerdict | null; reasoning: string | null; status: string } | null;
}

export interface RefinementRunRow {
    id: string;
    planId: string | null;
    status: RunStatus;
    createdAt: Date;
    runReview: { verdict: RunReviewVerdict | null; reasoning: string | null; status: string } | null;
}

/**
 * Loads the refinement loop attached to a snapshot, hydrated for UI rendering:
 *   - Payloads validated against `healingActionSchema` (typed discriminated union;
 *     malformed rows are dropped + logged rather than crashing the page).
 *   - Plans and test cases referenced by action.planId / action.testCaseId
 *     scalars resolved via batched lookups (RefinementAction has no relations).
 *   - Per-iteration outcomes (validated / failedAtGeneration / failedAtReplay /
 *     awaiting) derived from the latest gen + run that existed by the time the
 *     iteration completed (mirrors the activity-layer logic in
 *     `apps/workers/general/src/activities/refinement/analyze-results.ts` but
 *     batched across iterations).
 *
 * Returns `undefined` if no loop exists for the snapshot (legacy snapshots,
 * onboarding-only flows that never triggered one).
 */
export async function loadRefinementLoop(
    db: PrismaClient,
    snapshotId: string,
    parentLogger?: Logger,
): Promise<RefinementLoopView | undefined> {
    const logger = (parentLogger ?? rootLogger).child({ name: "loadRefinementLoop", snapshotId });

    const loop = await db.refinementLoop.findUnique({
        where: { snapshotId },
        select: loopSelect,
    });

    if (loop == null) return undefined;

    const planIds = new Set<string>();
    for (const iter of loop.iterations) for (const input of iter.inputs) planIds.add(input.planId);

    const [generations, runs, refLookups] = await Promise.all([
        loadGenerations(db, snapshotId, planIds),
        loadRuns(db, snapshotId, planIds),
        resolveActionRefs(db, loop.iterations),
    ]);

    const iterations: RefinementIterationView[] = loop.iterations.map((iter) => {
        const inputs = iter.inputs.map((i) => ({ planId: i.planId, testCase: i.plan.testCase }));
        // Pending iterations have inputs attached but haven't produced their own gen/run rows yet.
        // Computing outcomes against the current clock would pick up the previous iteration's failures
        // and mirror them verbatim, so short-circuit to all-awaiting until the workflow starts the iteration.
        const outcomes =
            iter.status === "pending"
                ? { validated: [], failedAtGeneration: [], failedAtReplay: [], awaiting: inputs }
                : computeIterationOutcomes({
                      inputs,
                      cutoff: iter.finishedAt ?? new Date(),
                      generations,
                      runs,
                  });
        return {
            id: iter.id,
            number: iter.number,
            status: iter.status,
            startedAt: iter.startedAt,
            finishedAt: iter.finishedAt ?? undefined,
            inputs,
            outcomes,
            actions: iter.actions.flatMap((row) => buildActionView(row, refLookups, logger)),
        };
    });

    return {
        id: loop.id,
        triggeredBy: loop.triggeredBy,
        status: loop.status,
        startedAt: loop.startedAt,
        finishedAt: loop.finishedAt ?? undefined,
        iterations,
    };
}

function buildActionView(row: ActionRow, refs: ActionRefLookups, logger: Logger): RefinementActionView[] {
    if (!isPlainObject(row.payload)) {
        logger.warn("Dropping refinement action whose payload is not a JSON object", {
            actionId: row.id,
            kind: row.kind,
            payloadType: row.payload === null ? "null" : Array.isArray(row.payload) ? "array" : typeof row.payload,
        });
        return [];
    }

    const parsed = healingActionSchema.safeParse({ kind: row.kind, ...row.payload });
    if (!parsed.success) {
        logger.warn("Dropping refinement action with malformed payload", {
            actionId: row.id,
            kind: row.kind,
            issues: parsed.error.issues,
        });
        return [];
    }
    const action = parsed.data;

    const plan = row.planId != null ? refs.plans.get(row.planId) : undefined;
    const testCase = row.testCaseId != null ? refs.testCases.get(row.testCaseId) : undefined;

    return [
        {
            id: row.id,
            kind: action.kind,
            payload: action,
            reasoning: row.reasoning,
            appliedAt: row.appliedAt ?? undefined,
            createdAt: row.createdAt,
            plan,
            testCase,
        },
    ];
}

async function loadGenerations(
    db: PrismaClient,
    snapshotId: string,
    planIds: Set<string>,
): Promise<RefinementGenerationRow[]> {
    if (planIds.size === 0) return [];
    return await db.testGeneration.findMany({
        where: { snapshotId, testPlanId: { in: [...planIds] } },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            testPlanId: true,
            status: true,
            createdAt: true,
            generationReview: { select: { verdict: true, reasoning: true, status: true } },
        },
    });
}

async function loadRuns(db: PrismaClient, snapshotId: string, planIds: Set<string>): Promise<RefinementRunRow[]> {
    if (planIds.size === 0) return [];
    return await db.run.findMany({
        where: { planId: { in: [...planIds] }, assignment: { snapshotId } },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            planId: true,
            status: true,
            createdAt: true,
            runReview: { select: { verdict: true, reasoning: true, status: true } },
        },
    });
}

interface ActionRefLookups {
    plans: Map<string, { id: string; testCaseId: string }>;
    testCases: Map<string, TestCaseLite>;
}

async function resolveActionRefs(db: PrismaClient, iterations: IterationRow[]): Promise<ActionRefLookups> {
    const planIds = new Set<string>();
    const testCaseIds = new Set<string>();

    for (const iter of iterations) {
        for (const action of iter.actions) {
            if (action.planId != null) planIds.add(action.planId);
            if (action.testCaseId != null) testCaseIds.add(action.testCaseId);
        }
    }

    const [planRows, testCaseRows] = await Promise.all([
        planIds.size === 0
            ? Promise.resolve([])
            : db.testPlan.findMany({
                  where: { id: { in: [...planIds] } },
                  select: { id: true, testCaseId: true },
              }),
        testCaseIds.size === 0
            ? Promise.resolve([])
            : db.testCase.findMany({
                  where: { id: { in: [...testCaseIds] } },
                  select: { id: true, name: true, slug: true },
              }),
    ]);

    return {
        plans: new Map(planRows.map((r) => [r.id, r])),
        testCases: new Map(testCaseRows.map((r) => [r.id, r])),
    };
}

export function computeIterationOutcomes({
    inputs,
    cutoff,
    generations,
    runs,
}: {
    inputs: Array<{ planId: string; testCase: TestCaseLite }>;
    cutoff: Date;
    generations: RefinementGenerationRow[];
    runs: RefinementRunRow[];
}): RefinementIterationOutcomes {
    const outcomes: RefinementIterationOutcomes = {
        validated: [],
        failedAtGeneration: [],
        failedAtReplay: [],
        awaiting: [],
    };

    for (const input of inputs) {
        const gen = latestBeforeCutoff(
            generations.filter((g) => g.testPlanId === input.planId),
            cutoff,
        );
        if (gen == null) {
            outcomes.awaiting.push({ planId: input.planId, testCase: input.testCase });
            continue;
        }

        const review = gen.generationReview;
        const genSuccess =
            gen.status === "success" && review != null && review.status === "completed" && review.verdict === "success";

        if (!genSuccess) {
            outcomes.failedAtGeneration.push({
                planId: input.planId,
                testCase: input.testCase,
                generationId: gen.id,
                generationStatus: gen.status,
                verdictKind: review?.verdict ?? undefined,
                reviewReasoning: review?.reasoning ?? undefined,
            });
            continue;
        }

        const run = latestBeforeCutoff(
            runs.filter((r) => r.planId === input.planId),
            cutoff,
        );
        if (run == null) {
            outcomes.awaiting.push({ planId: input.planId, testCase: input.testCase });
            continue;
        }

        if (run.status === "success") {
            outcomes.validated.push({
                planId: input.planId,
                testCase: input.testCase,
                generationId: gen.id,
                runId: run.id,
            });
            continue;
        }

        const runReview = run.runReview;
        outcomes.failedAtReplay.push({
            planId: input.planId,
            testCase: input.testCase,
            runId: run.id,
            runStatus: run.status,
            verdictKind: runReview?.verdict ?? undefined,
            reviewReasoning: runReview?.reasoning ?? undefined,
        });
    }

    return outcomes;
}

function latestBeforeCutoff<T extends { createdAt: Date }>(rows: T[], cutoff: Date): T | undefined {
    let best: T | undefined;
    for (const row of rows) {
        if (row.createdAt.getTime() > cutoff.getTime()) continue;
        if (best == null || row.createdAt.getTime() > best.createdAt.getTime()) best = row;
    }
    return best;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
