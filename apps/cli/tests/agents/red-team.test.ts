import { describe, expect, it } from "vitest";
import type { FlowBudget } from "../../src/agents/05-test-generator/budget";
import { renderRedTeamBrief } from "../../src/agents/05-test-generator/red-team";

function budget(overrides: Partial<FlowBudget>): FlowBudget {
    return {
        flowId: "checkout",
        name: "Checkout",
        tier: 1,
        allowance: 6,
        riskDrivers: [],
        invariants: [],
        ...overrides,
    };
}

describe("renderRedTeamBrief", () => {
    it("renders a brief for a tier-1 flow with drivers, including each driver's playbook", () => {
        const brief = renderRedTeamBrief(budget({ tier: 1, riskDrivers: ["permissions"] }));

        expect(brief).toBeDefined();
        expect(brief).toContain("Checkout");
        // Text from the "permissions" playbook - proves the driver resolved to its play.
        expect(brief).toContain("DIFFERENT actor sees");
    });

    it("returns undefined when a tier-1 flow has no risk drivers", () => {
        expect(renderRedTeamBrief(budget({ tier: 1, riskDrivers: [] }))).toBeUndefined();
    });

    it("returns undefined for a non-tier-1 flow even with drivers", () => {
        expect(renderRedTeamBrief(budget({ tier: 2, riskDrivers: ["permissions"] }))).toBeUndefined();
    });

    it("folds the flow's invariants in as claims to falsify", () => {
        const brief = renderRedTeamBrief(
            budget({
                tier: 1,
                riskDrivers: ["permissions"],
                invariants: ["only the owner can view this document"],
            }),
        );

        expect(brief).toContain("only the owner can view this document");
        expect(brief).toContain("FALSE");
    });
});
