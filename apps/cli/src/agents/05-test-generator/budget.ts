import type { FlowPlan, RunPlan } from "../../ui/types";
import { type CoreFlow, type CoreFlowsSpec, type RiskDriver, TIER_BUDGET_SHARE } from "../01-kb-generator/flow-spec";

/**
 * Tests a page gets simply for existing, before any ranking applies. Coverage and
 * budget are different questions: every page must be VISITED, or the suite cannot
 * tell you what it failed to cover, but a page does not have to be worth ten tests
 * to be worth one. Without this floor a tier-3 page would get nothing and its
 * breakage would be invisible.
 */
const SMOKE_TESTS_PER_PAGE = 1;

/** A flow with no stated risk still gets a share; drivers scale it from there. */
const BASE_RISK_WEIGHT = 1;

/**
 * Tests the whole suite aims for, per page discovered.
 *
 * A ceiling, not a quota - flows spend only what they can justify. It exists
 * because an unbounded run on a 113-page app wrote 440 tests costing $157, a third
 * of them on settings toggles, and nothing in the loop had any opinion about when
 * enough was enough. Two per page buys a smoke test plus roughly one real one on
 * average, with tiering deciding who gets more than their average.
 */
const TESTS_PER_PAGE = 2;

/** How large a suite this app warrants. */
export function targetTestCount(pageCount: number): number {
    return pageCount * TESTS_PER_PAGE;
}

export interface FlowBudget {
    flowId: string;
    name: string;
    tier: 1 | 2 | 3;
    /** Tests this flow may claim beyond the per-page smoke floor. */
    allowance: number;
    riskDrivers: readonly RiskDriver[];
    invariants: readonly string[];
}

export interface BudgetPlan {
    total: number;
    smokeFloor: number;
    /**
     * Shared ceiling for pages no flow claims. Flow entry points are a handful of
     * routes, not a partition of the app - on a 113-page product they resolved
     * 15-31% of pages - so this is the common case, not an edge case, and it needs
     * a real limit rather than an exemption.
     */
    unclaimedAllowance: number;
    byFlow: Map<string, FlowBudget>;
    /** Route -> flow id, for deciding which budget a node draws from. */
    flowByRoute: Map<string, string>;
}

/**
 * Decide up front how many tests each flow may write.
 *
 * Reserved per flow rather than competed for. A single global pool would be spent
 * by whichever page a worker happened to start on, so with parallel generation the
 * allocation would be decided by scheduling order - a settings page racing ahead
 * of the flow the product is sold on. Reserving means a tier-3 worker cannot touch
 * tier 1's allowance no matter when it runs, and no barrier is needed to make that
 * true.
 *
 * Tier picks the size of each pool; risk decides how a pool is split among the
 * flows inside it. So a bug-prone tier-3 surface takes the largest slice of a small
 * pool and still cannot outrank tier 1 - which is the intended behaviour, since
 * "where the bugs are" and "what the product is for" are different questions and
 * only the second one should decide the big numbers.
 */
export function planBudget(spec: CoreFlowsSpec, pageCount: number, totalTests: number): BudgetPlan {
    const smokeFloor = pageCount * SMOKE_TESTS_PER_PAGE;
    const discretionary = Math.max(0, totalTests - smokeFloor);

    const byFlow = new Map<string, FlowBudget>();
    for (const tier of [1, 2, 3] as const) {
        const flows = spec.flows.filter((f) => f.tier === tier);
        if (flows.length === 0) continue;

        const pool = Math.round(discretionary * TIER_BUDGET_SHARE[tier]);
        const weights = flows.map(riskWeight);
        const totalWeight = weights.reduce((sum, w) => sum + w, 0);

        flows.forEach((flow, i) => {
            const weight = weights[i] ?? BASE_RISK_WEIGHT;
            byFlow.set(flow.id, {
                flowId: flow.id,
                name: flow.feature,
                tier,
                allowance: Math.max(1, Math.round((pool * weight) / totalWeight)),
                riskDrivers: flow.riskDrivers,
                invariants: flow.invariants,
            });
        });
    }

    const flowByRoute = new Map<string, string>();
    for (const flow of spec.flows) {
        for (const route of flow.entryPoints) flowByRoute.set(normalizeRoute(route), flow.id);
    }

    // What tier 3 would get for one flow: unranked pages are, by definition, not
    // what the product is for.
    const unclaimedAllowance = Math.max(1, Math.round(discretionary * TIER_BUDGET_SHARE[3]));

    return { total: totalTests, smokeFloor, unclaimedAllowance, byFlow, flowByRoute };
}

/**
 * The run's valid flow ids - the closed set every generated test's `flow` field
 * must draw from. Keyed off the budget ledger, which already indexes every flow by
 * id, so there is no second list to keep in sync. Empty only when there is no
 * ranking at all, which enforcement reads as "do not enforce".
 */
export function planFlowIds(plan: BudgetPlan): ReadonlySet<string> {
    return new Set(plan.byFlow.keys());
}

/**
 * Fold the flow ranking and the budget ledger back into one display slice - the
 * reasoning the run computes and would otherwise discard. Everything here already
 * exists in `spec` and `budget`; this only joins them, orders them the way a
 * reader wants (most-important tier first, biggest allowance first inside a
 * tier), and rolls up the per-tier totals for the summary line.
 */
export function buildRunPlan(spec: CoreFlowsSpec, budget: BudgetPlan): RunPlan {
    const flows: FlowPlan[] = spec.flows.map((flow) => ({
        flowId: flow.id,
        feature: flow.feature,
        tier: flow.tier,
        tierReason: flow.tierReason,
        riskDrivers: flow.riskDrivers,
        entryPoints: flow.entryPoints,
        invariants: flow.invariants,
        allowance: budget.byFlow.get(flow.id)?.allowance ?? 0,
    }));
    flows.sort((a, b) => a.tier - b.tier || b.allowance - a.allowance);

    const tierTotals: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
    for (const flow of flows) tierTotals[flow.tier] += flow.allowance;

    return {
        pitch: spec.pitch,
        total: budget.total,
        smokeFloor: budget.smokeFloor,
        tierTotals,
        flows,
        // Raw churn/retouch signals aren't persisted anywhere yet; riskDrivers are
        // their distilled output. See repo-signals.ts (collected, rendered into the
        // KB prompt, then dropped).
        signalsPersisted: false,
    };
}

/**
 * Which flow a route belongs to, tolerating the difference between how a router
 * spells a parameter and how a flow's author did. `/orders/[id]`, `/orders/:id`
 * and `/orders/123` all name the same surface, and a lookup that misses would
 * silently drop the page out of every budget.
 */
export function flowForRoute(plan: BudgetPlan, route: string): string | undefined {
    const normalized = normalizeRoute(route);
    const exact = plan.flowByRoute.get(normalized);
    if (exact != null) return exact;

    // Longest match wins, so a flow claiming /settings/billing beats one claiming
    // /settings for that page, and an exact claim always beats a prefix.
    const segments = normalized.split("/");
    let best: string | undefined;
    let bestDepth = 0;
    for (const [claimed, flowId] of plan.flowByRoute) {
        const claimedSegments = claimed.split("/");
        if (claimedSegments.length > segments.length) continue;
        if (claimedSegments.length <= bestDepth) continue;
        if (claimedSegments.every((seg, i) => seg === "*" || seg === segments[i])) {
            best = flowId;
            bestDepth = claimedSegments.length;
        }
    }
    return best;
}

/** Collapse route parameters so two spellings of the same route compare equal. */
function normalizeRoute(route: string): string {
    const withoutParams = route
        .replace(/\[\[?\.\.\.[^\]]+\]?\]/g, "*")
        .replace(/\[[^\]]+\]/g, "*")
        .replace(/:[^/]+/g, "*");
    const trimmed = withoutParams.replace(/\/+$/, "").toLowerCase();
    return trimmed.length > 0 ? trimmed : "/";
}

/**
 * How much of its tier's pool a flow deserves relative to its siblings.
 *
 * Driven by the count of distinct ways the flow can break rather than by a score,
 * because a driver is a claim about the shape of the input space - free text, a
 * canvas, a resumable flow - and each one is an independent axis along which tests
 * are worth writing. A flow with three of them genuinely has more to test than one
 * with none, in a way that "how much code is there" does not capture.
 */
function riskWeight(flow: CoreFlow): number {
    return BASE_RISK_WEIGHT + flow.riskDrivers.length;
}
