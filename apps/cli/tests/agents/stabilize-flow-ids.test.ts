import { describe, expect, it } from "vitest";
import type { CoreFlow, CoreFlowsSpec } from "../../src/agents/01-kb-generator/flow-spec";
import { stabilizeFlowIds } from "../../src/agents/01-kb-generator/stabilize-flow-ids";

/**
 * The flow id is the key every cross-run comparison and the closed-set enforcement
 * rely on, and the model reinvents it every run. These assert the id becomes a
 * deterministic function of the routes a flow owns, so identical routes always
 * produce the identical id however the model chose to name the flow.
 */
function flow(id: string, entryPoints: string[], tier: 1 | 2 | 3 = 1): CoreFlow {
    return {
        id,
        feature: `Feature ${id}`,
        description: "a flow that does something",
        mission: "must do its one job correctly",
        tier,
        tierReason: "because the pitch says so, at some length",
        invariants: [],
        riskDrivers: [],
        entryPoints,
    };
}

function spec(...flows: CoreFlow[]): CoreFlowsSpec {
    return { pitch: "A product that does a thing for people who need it", flows };
}

function ids(result: CoreFlowsSpec): string[] {
    return result.flows.map((f) => f.id);
}

describe("stabilizeFlowIds", () => {
    it("gives identical routes the identical id, whatever the model named the flow", () => {
        // The exact regression: the same creation flow came back as `test-creation`
        // one run and `test-authoring` the next, both owning only /creation.
        const a = stabilizeFlowIds(spec(flow("test-creation", ["/creation"])));
        const b = stabilizeFlowIds(spec(flow("test-authoring", ["/creation"])));
        expect(ids(a)).toEqual(["creation"]);
        expect(ids(b)).toEqual(["creation"]);
    });

    it("anchors the id to the shallowest route, so a peripheral route flapping cannot rename it", () => {
        const withPeripherals = stabilizeFlowIds(spec(flow("x", ["/creation", "/drafts", "/wizard"])));
        const withoutThem = stabilizeFlowIds(spec(flow("x", ["/creation"])));
        expect(ids(withPeripherals)).toEqual(["creation"]);
        expect(ids(withoutThem)).toEqual(["creation"]);
    });

    it("breaks ties between equally shallow routes lexicographically", () => {
        const result = stabilizeFlowIds(spec(flow("x", ["/wizard", "/creation", "/analytics"])));
        expect(ids(result)).toEqual(["analytics"]);
    });

    it("drops route parameters when naming the flow", () => {
        const result = stabilizeFlowIds(spec(flow("x", ["/run", "/run/[id]", "/run/:tag"])));
        expect(ids(result)).toEqual(["run"]);
    });

    it("names a multi-segment route by its static path", () => {
        const result = stabilizeFlowIds(spec(flow("x", ["/settings/integrations", "/settings/keys"])));
        expect(ids(result)).toEqual(["settings-integrations"]);
    });

    it("falls back to a readable id when a flow owns only the root or parameters", () => {
        const result = stabilizeFlowIds(spec(flow("x", ["/", "/[id]"])));
        expect(ids(result)).toEqual(["home"]);
    });

    it("disambiguates colliding ids into a distinct, idempotent set", () => {
        // Two flows claiming the same shallowest route is a model error the prompt
        // tries to prevent, but the closed set must still hold distinct ids.
        const input = spec(flow("a", ["/settings"], 2), flow("b", ["/settings"], 3));
        const once = stabilizeFlowIds(input);
        const twice = stabilizeFlowIds(input);
        expect(new Set(ids(once))).toEqual(new Set(["settings", "settings-2"]));
        expect(ids(once)).toEqual(ids(twice));
    });

    it("touches only the id, leaving tier, feature and entryPoints intact", () => {
        const input = flow("whatever", ["/run", "/run/[id]"], 2);
        const [out] = stabilizeFlowIds(spec(input)).flows;
        expect(out).toEqual({ ...input, id: "run" });
    });
});
