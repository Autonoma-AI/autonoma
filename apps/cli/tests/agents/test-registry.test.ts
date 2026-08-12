import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BudgetPlan, FlowBudget } from "../../src/agents/05-test-generator/budget";

// The registry's job is bookkeeping and serialisation; whether two sentences mean
// the same thing is the judge's, and it is a model call. Stub it so these tests
// are about claiming, rejecting and racing rather than about semantics.
const judgeDuplicates = vi.hoisted(() => vi.fn());
vi.mock("../../src/agents/05-test-generator/duplicate-judge", () => ({ judgeDuplicates }));

const { TestRegistry } = await import("../../src/agents/05-test-generator/test-registry");

/** A budget whose only load-bearing part here is the set of flow ids it indexes. */
function budgetWithFlows(ids: string[]): BudgetPlan {
    const byFlow = new Map<string, FlowBudget>();
    for (const id of ids) {
        byFlow.set(id, { flowId: id, name: id, tier: 1, allowance: 10, riskDrivers: [], invariants: [] });
    }
    return { total: 100, smokeFloor: 1, unclaimedAllowance: 5, byFlow, flowByRoute: new Map() };
}

/** A budget with explicit per-flow discretionary allowances, for the floor tests. */
function budgetWith(flows: { id: string; allowance: number }[], unclaimedAllowance = 5): BudgetPlan {
    const byFlow = new Map<string, FlowBudget>();
    for (const f of flows) {
        byFlow.set(f.id, { flowId: f.id, name: f.id, tier: 3, allowance: f.allowance, riskDrivers: [], invariants: [] });
    }
    return { total: 100, smokeFloor: 1, unclaimedAllowance, byFlow, flowByRoute: new Map() };
}

beforeAll(() => {
    process.env.DONT_TRACK = "1";
});

/** Judge that calls everything distinct. */
function acceptAll() {
    judgeDuplicates.mockImplementation(async () => new Map());
}

/** Judge that marks `dupe` as duplicating `of`. */
function reject(dupe: string, of: string) {
    judgeDuplicates.mockImplementation(async () => new Map([[dupe, { duplicateOf: of }]]));
}

describe("TestRegistry", () => {
    it("accepts proposals that cover new behaviour and remembers them", async () => {
        acceptAll();
        const registry = new TestRegistry("model");

        const verdicts = await registry.propose("node-a", ["Sending money to an external business debits checking"]);

        expect(verdicts).toEqual([
            { description: "Sending money to an external business debits checking", accepted: true },
        ]);
        expect(registry.claimed).toHaveLength(1);
    });

    it("rejects a duplicate and names what already covers it", async () => {
        acceptAll();
        const registry = new TestRegistry("model");
        await registry.propose("node-a", ["Transfer money from savings to checking"]);

        reject("Move funds between own accounts", "Transfer money from savings to checking");
        const [verdict] = await registry.propose("node-b", ["Move funds between own accounts"]);

        expect(verdict?.accepted).toBe(false);
        expect(verdict?.duplicateOf).toBe("Transfer money from savings to checking");
        expect(verdict?.reason).toContain("Already covered by");
    });

    it("does not claim a rejected proposal, so it cannot block a later distinct one", async () => {
        acceptAll();
        const registry = new TestRegistry("model");
        await registry.propose("node-a", ["Original test"]);

        reject("Duplicate test", "Original test");
        await registry.propose("node-b", ["Duplicate test"]);

        expect(registry.claimed.map((c) => c.description)).toEqual(["Original test"]);
    });

    it("judges concurrent proposals one at a time, so two agents cannot both claim the same gap", async () => {
        let inFlight = 0;
        let peak = 0;
        judgeDuplicates.mockImplementation(async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((res) => setTimeout(res, 5));
            inFlight--;
            return new Map();
        });
        const registry = new TestRegistry("model");

        await Promise.all([
            registry.propose("a", ["test one behaviour"]),
            registry.propose("b", ["test another behaviour"]),
            registry.propose("c", ["test a third behaviour"]),
        ]);

        expect(peak).toBe(1);
        expect(registry.claimed).toHaveLength(3);
    });

    it("sees earlier claims from a concurrent proposal, not a stale snapshot", async () => {
        const seen: number[] = [];
        judgeDuplicates.mockImplementation(async ({ existing }: { existing: string[] }) => {
            seen.push(existing.length);
            await new Promise((res) => setTimeout(res, 5));
            return new Map();
        });
        const registry = new TestRegistry("model");

        await Promise.all([registry.propose("a", ["first behaviour"]), registry.propose("b", ["second behaviour"])]);

        // The second proposal must have been judged against the first's claim.
        expect(seen).toEqual([0, 1]);
    });

    it("keeps serving proposals after one throws", async () => {
        judgeDuplicates.mockRejectedValueOnce(new Error("judge exploded"));
        const registry = new TestRegistry("model");

        await expect(registry.propose("a", ["a behaviour"])).rejects.toThrow("judge exploded");

        acceptAll();
        const verdicts = await registry.propose("b", ["another behaviour"]);

        expect(verdicts[0]?.accepted).toBe(true);
    });
});

describe("TestRegistry flow-id enforcement", () => {
    it("rejects a proposal whose declared flow is outside the closed set, naming the valid ids", async () => {
        acceptAll();
        const registry = new TestRegistry("model", budgetWithFlows(["funds-management", "account-settings"]));

        const [verdict] = await registry.propose("node-a", ["Sending money debits checking"], undefined, "Funds Management");

        expect(verdict?.accepted).toBe(false);
        expect(verdict?.reason).toContain("funds-management");
        expect(verdict?.reason).toContain("account-settings");
        expect(registry.claimed).toHaveLength(0);
    });

    it("does not pay for the duplicate judge when the flow id is invalid", async () => {
        judgeDuplicates.mockClear();
        acceptAll();
        const registry = new TestRegistry("model", budgetWithFlows(["funds-management"]));

        await registry.propose("node-a", ["some new behaviour to prove"], undefined, "not-a-real-flow");

        expect(judgeDuplicates).not.toHaveBeenCalled();
    });

    it("accepts a proposal whose declared flow is a member", async () => {
        acceptAll();
        const registry = new TestRegistry("model", budgetWithFlows(["funds-management"]));

        const [verdict] = await registry.propose(
            "node-a",
            ["Sending money debits checking"],
            "funds-management",
            "funds-management",
        );

        expect(verdict?.accepted).toBe(true);
        expect(registry.claimed).toHaveLength(1);
    });

    it("does not enforce when the run has no ranking, so a degraded run is unaffected", async () => {
        acceptAll();
        const registry = new TestRegistry("model");

        const [verdict] = await registry.propose("node-a", ["Sending money debits checking"], undefined, "Anything At All");

        expect(verdict?.accepted).toBe(true);
    });
});

describe("TestRegistry smoke floor", () => {
    it("still accepts a page's first test when its flow has no discretionary budget left", async () => {
        acceptAll();
        // A tier-3 flow with zero discretionary allowance - the exact shape that
        // starved settings pages to zero coverage before the floor was enforced.
        const registry = new TestRegistry("model", budgetWith([{ id: "settings", allowance: 0 }]));

        const [floor] = await registry.propose("settings-page", ["the settings page loads and a toggle persists"], "settings", "settings");
        const [second] = await registry.propose("settings-page", ["a second, deeper settings behaviour is verified"], "settings", "settings");

        expect(floor?.accepted).toBe(true);
        expect(second?.accepted).toBe(false);
        expect(registry.claimed).toHaveLength(1);
    });

    it("covers a page no flow claims even after the shared unclaimed pool is spent", async () => {
        acceptAll();
        const registry = new TestRegistry("model", budgetWith([{ id: "core", allowance: 10 }], 0));

        const [floor] = await registry.propose("orphan-page", ["the orphan page renders and its button works"]);
        const [second] = await registry.propose("orphan-page", ["another orphan-page behaviour worth a test"]);

        expect(floor?.accepted).toBe(true);
        expect(second?.accepted).toBe(false);
    });

    it("does not spend discretionary budget on the floor test - the pool funds only the tests above it", async () => {
        acceptAll();
        const registry = new TestRegistry("model", budgetWith([{ id: "core", allowance: 1 }]));

        // Floor (free) + one discretionary (allowance 1) both land; the third has
        // nothing left to draw on.
        const [floor] = await registry.propose("core-page", ["the page loads and its primary action works"], "core", "core");
        const [discretionary] = await registry.propose("core-page", ["a second, distinct core behaviour"], "core", "core");
        const [third] = await registry.propose("core-page", ["a third core behaviour with no budget left"], "core", "core");

        expect(floor?.accepted).toBe(true);
        expect(discretionary?.accepted).toBe(true);
        expect(third?.accepted).toBe(false);
    });

    it("counts the floor per page, not per node, so a page's sub-features share its one free test", async () => {
        acceptAll();
        // Both nodes resolve to the same page, and the flow has no discretionary
        // budget, so exactly one of them gets the free floor test.
        const pageForNode = () => "settings-page";
        const registry = new TestRegistry("model", budgetWith([{ id: "settings", allowance: 0 }]), pageForNode);

        const [pageTest] = await registry.propose("settings-page", ["the settings page renders and a field saves"], "settings", "settings");
        const [featureTest] = await registry.propose("settings-notifications", ["the notifications sub-feature toggles"], "settings", "settings");

        expect(pageTest?.accepted).toBe(true);
        expect(featureTest?.accepted).toBe(false);
        expect(registry.claimed).toHaveLength(1);
    });
});
