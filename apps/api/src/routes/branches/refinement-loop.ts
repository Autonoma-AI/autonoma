import {
    computeIterationOutcomes,
    type RefinementGenerationRow,
    type RefinementIterationOutcomes,
    type TestCaseLite,
} from "@autonoma/checkpoint";
import type { Prisma, PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { healingActionSchema, type HealingAction } from "@autonoma/types";

export interface RefinementActionView {
    id: string;
    kind: HealingAction["kind"];
    payload: HealingAction;
    reasoning: string;
    appliedAt?: Date;
    createdAt: Date;
    plan?: { id: string; testCaseId: string };
    testCase?: TestCaseLite;
    // The generation whose review drove this action (culls + reports are always
    // failure-driven and cite the review that surfaced the problem). Resolved from the
    // action's `reviewLink` so the UI can link straight to the cited generation.
    reviewLink?: { kind: "generation"; id: string };
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

/**
 * Loads the refinement loop attached to a snapshot, hydrated for UI rendering:
 *   - Payloads validated against `healingActionSchema` (typed discriminated union;
 *     malformed rows are dropped + logged rather than crashing the page).
 *   - Plans and test cases referenced by action.planId / action.testCaseId
 *     scalars resolved via batched lookups (RefinementAction has no relations).
 *   - Per-iteration outcomes (validated / failedAtGeneration / awaiting) derived
 *     from the latest generation that existed by the time the iteration completed
 *     (mirrors the activity-layer logic in
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

    const [generations, refLookups] = await Promise.all([
        loadGenerations(db, snapshotId, planIds),
        resolveActionRefs(db, loop.iterations),
    ]);

    const iterations: RefinementIterationView[] = loop.iterations.map((iter) => {
        const inputs = iter.inputs.map((i) => ({ planId: i.planId, testCase: i.plan.testCase }));
        // Pending iterations have inputs attached but haven't produced their own gen/run rows yet.
        // Computing outcomes against the current clock would pick up the previous iteration's failures
        // and mirror them verbatim, so short-circuit to all-awaiting until the workflow starts the iteration.
        const outcomes =
            iter.status === "pending"
                ? { validated: [], failedAtGeneration: [], awaiting: inputs }
                : computeIterationOutcomes({
                      inputs,
                      cutoff: iter.finishedAt ?? new Date(),
                      generations,
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
            reviewLink: resolveReviewLink(action, refs),
        },
    ];
}

/**
 * Resolves an action's `reviewLink` (a generation *review* id) to the generation
 * it reviews, so the UI can link to the cited inspector page. `update_plan`
 * carries no review link; report + remove actions always do.
 */
function resolveReviewLink(
    action: HealingAction,
    refs: ActionRefLookups,
): { kind: "generation"; id: string } | undefined {
    if (action.kind === "update_plan") return undefined;

    const generationId = refs.generationByReviewId.get(action.reviewLink.generationReviewId);
    return generationId != null ? { kind: "generation", id: generationId } : undefined;
}

async function loadGenerations(
    db: PrismaClient,
    snapshotId: string,
    planIds: Set<string>,
): Promise<RefinementGenerationRow[]> {
    if (planIds.size === 0) return [];
    return await db.testGeneration.findMany({
        where: { snapshotId, shadow: false, testPlanId: { in: [...planIds] } },
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

interface ActionRefLookups {
    plans: Map<string, { id: string; testCaseId: string }>;
    testCases: Map<string, TestCaseLite>;
    generationByReviewId: Map<string, string>;
}

async function resolveActionRefs(db: PrismaClient, iterations: IterationRow[]): Promise<ActionRefLookups> {
    const planIds = new Set<string>();
    const testCaseIds = new Set<string>();
    const generationReviewIds = new Set<string>();

    for (const iter of iterations) {
        for (const action of iter.actions) {
            if (action.planId != null) planIds.add(action.planId);
            if (action.testCaseId != null) testCaseIds.add(action.testCaseId);
            const reviewLink = extractReviewLink(action.payload);
            if (reviewLink?.generationReviewId != null) generationReviewIds.add(reviewLink.generationReviewId);
        }
    }

    const [planRows, testCaseRows, generationReviewRows] = await Promise.all([
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
        generationReviewIds.size === 0
            ? Promise.resolve([])
            : db.generationReview.findMany({
                  where: { id: { in: [...generationReviewIds] } },
                  select: { id: true, generationId: true },
              }),
    ]);

    return {
        plans: new Map(planRows.map((r) => [r.id, r])),
        testCases: new Map(testCaseRows.map((r) => [r.id, r])),
        generationByReviewId: new Map(generationReviewRows.map((r) => [r.id, r.generationId])),
    };
}

/**
 * Best-effort extraction of an action payload's `reviewLink` ids without a full
 * schema parse - used only to know which reviews to batch-load. The full
 * validated `reviewLink` is read off the parsed action later.
 */
function extractReviewLink(payload: unknown): { generationReviewId?: string } | undefined {
    if (!isPlainObject(payload)) return undefined;
    const link = payload.reviewLink;
    if (!isPlainObject(link)) return undefined;
    const generationReviewId = typeof link.generationReviewId === "string" ? link.generationReviewId : undefined;
    return { generationReviewId };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
