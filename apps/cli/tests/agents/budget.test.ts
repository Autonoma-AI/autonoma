import { describe, expect, it } from "vitest";
import type { CoreFlowsSpec } from "../../src/agents/01-kb-generator/flow-spec";
import { buildRunPlan, flowForRoute, planBudget, targetTestCount } from "../../src/agents/05-test-generator/budget";

/**
 * Budget allocation decides what the suite spends its money on, and gets it wrong
 * silently: an over-funded settings tier just looks like a big suite. A real run
 * put 150 of 440 tests on settings while the product's core flow got 16, which is
 * the behaviour these assert against.
 */
function flow(id: string, tier: 1 | 2 | 3, routes: string[], drivers: string[] = []) {
    return {
        id,
        feature: id,
        description: "a flow that does something",
        mission: "must do its one job correctly",
        tier,
        tierReason: "because the pitch says so, at some length",
        invariants: [],
        riskDrivers: drivers,
        entryPoints: routes,
    };
}

function spec(...flows: ReturnType<typeof flow>[]): CoreFlowsSpec {
    return { pitch: "A product that does a thing for people who need it", flows } as CoreFlowsSpec;
}

describe("planBudget", () => {
    it("gives tier 1 more than tier 3, however many flows each holds", () => {
        // Three tier-3 flows against one tier-1: counting flows would invert this.
        const plan = planBudget(
            spec(
                flow("core", 1, ["/core"]),
                flow("settings", 3, ["/settings"]),
                flow("admin", 3, ["/admin"]),
                flow("billing", 3, ["/billing"]),
            ),
            50,
            targetTestCount(50),
        );

        const tier1 = plan.byFlow.get("core")!.allowance;
        const tier3 = ["settings", "admin", "billing"].reduce((n, id) => n + plan.byFlow.get(id)!.allowance, 0);

        expect(tier1).toBeGreaterThan(tier3);
    });

    it("splits a tier's pool toward the flow with more ways to break", () => {
        const plan = planBudget(
            spec(
                flow("canvas", 1, ["/canvas"], ["spatial_manipulation", "interruptible_state", "realtime_async"]),
                flow("list", 1, ["/list"]),
            ),
            40,
            targetTestCount(40),
        );

        expect(plan.byFlow.get("canvas")!.allowance).toBeGreaterThan(plan.byFlow.get("list")!.allowance);
    });

    it("reserves a smoke test for every page before anything is ranked", () => {
        const plan = planBudget(spec(flow("core", 1, ["/core"])), 30, targetTestCount(30));

        expect(plan.smokeFloor).toBe(30);
    });

    it("never leaves a flow with nothing, even in an over-subscribed tier", () => {
        const plan = planBudget(
            spec(...Array.from({ length: 12 }, (_, i) => flow(`f${i}`, 3, [`/f${i}`]))),
            15,
            targetTestCount(15),
        );

        for (const budget of plan.byFlow.values()) expect(budget.allowance).toBeGreaterThanOrEqual(1);
    });
});

describe("flowForRoute", () => {
    const plan = () =>
        planBudget(spec(flow("orders", 1, ["/orders/[id]"]), flow("settings", 3, ["/settings"])), 20, 40);

    it("matches a route however its parameter is spelled", () => {
        // The router, the flow's author and a live URL each write this differently.
        for (const route of ["/orders/[id]", "/orders/:id", "/orders/12345"]) {
            expect(flowForRoute(plan(), route), route).toBe("orders");
        }
    });

    it("gives a nested route to the flow that claims its prefix", () => {
        expect(flowForRoute(plan(), "/settings/members")).toBe("settings");
    });

    it("returns nothing for a route no flow claims, rather than guessing", () => {
        expect(flowForRoute(plan(), "/unrelated")).toBeUndefined();
    });
});

describe("buildRunPlan", () => {
    const planSpec = () =>
        spec(
            flow("settings", 3, ["/settings"]),
            flow("canvas", 1, ["/canvas"], ["spatial_manipulation", "interruptible_state"]),
            flow("list", 1, ["/list"]),
        );

    it("orders flows by tier, then by allowance within a tier", () => {
        const s = planSpec();
        const plan = buildRunPlan(s, planBudget(s, 40, targetTestCount(40)));

        expect(plan.flows.map((f) => f.flowId)).toEqual(["canvas", "list", "settings"]);
        // canvas has more risk drivers than list, so it leads its tier.
        expect(plan.flows[0]!.allowance).toBeGreaterThanOrEqual(plan.flows[1]!.allowance);
    });

    it("rolls up per-tier discretionary totals that match the ledger", () => {
        const s = planSpec();
        const budget = planBudget(s, 40, targetTestCount(40));
        const plan = buildRunPlan(s, budget);

        const tier1FromLedger = ["canvas", "list"].reduce((n, id) => n + budget.byFlow.get(id)!.allowance, 0);
        expect(plan.tierTotals[1]).toBe(tier1FromLedger);
        expect(plan.tierTotals[3]).toBe(budget.byFlow.get("settings")!.allowance);
    });

    it("carries the pitch, reasons, risk and entry points through untouched", () => {
        const s = planSpec();
        const plan = buildRunPlan(s, planBudget(s, 40, targetTestCount(40)));

        expect(plan.pitch).toBe(s.pitch);
        const canvas = plan.flows.find((f) => f.flowId === "canvas")!;
        expect(canvas.tier).toBe(1);
        expect(canvas.riskDrivers).toEqual(["spatial_manipulation", "interruptible_state"]);
        expect(canvas.entryPoints).toEqual(["/canvas"]);
        // Raw git signals are not persisted yet; the flag says so honestly.
        expect(plan.signalsPersisted).toBe(false);
    });
});

describe("unclaimed pages", () => {
    it("gets a bounded allowance rather than an exemption", () => {
        // Flow entry points cover a fraction of a real app's routes, so "no flow
        // claims this" is the common case. Left unbounded it inverted the scheme:
        // the pages outside the ranking were the only ones able to spend freely.
        const plan = planBudget(spec(flow("core", 1, ["/core"])), 100, targetTestCount(100));

        expect(plan.unclaimedAllowance).toBeGreaterThan(0);
        expect(plan.unclaimedAllowance).toBeLessThan(plan.byFlow.get("core")!.allowance);
    });
});
