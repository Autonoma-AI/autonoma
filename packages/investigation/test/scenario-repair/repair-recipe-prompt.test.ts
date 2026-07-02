import { describe, expect, it } from "vitest";
import { buildRepairRecipePrompt } from "../../src";
import type { RepairRecipeInput } from "../../src";

const BASE: RepairRecipeInput = {
    appSlug: "acme",
    prNumber: 42,
    slug: "search-finds-project",
    currentCreateGraph: '{"Project":[{"_alias":"p1","name":"Existing"}]}',
    recipeChange: "seed a second project named Annual Upkeep",
    failureDetail: "the search matched nothing",
    testPlan: "search for Annual Upkeep and assert it appears",
};

describe("buildRepairRecipePrompt", () => {
    it("omits the prior-attempts section on the first pass", () => {
        const prompt = buildRepairRecipePrompt(BASE);
        expect(prompt).not.toContain("ALREADY tried");
    });

    it("renders each prior attempt's graph and how the test failed, so the agent avoids repeating it", () => {
        const prompt = buildRepairRecipePrompt({
            ...BASE,
            priorAttempts: [
                {
                    createGraphJson: '{"Project":[{"_alias":"p2","name":"Annual Upkeep"}]}',
                    failureDetail: "the project was created but showed on page 2, off-screen",
                },
            ],
        });
        expect(prompt).toContain("ALREADY tried");
        expect(prompt).toContain("Annual Upkeep");
        expect(prompt).toContain("off-screen");
        // The instruction must make clear seeding is not the problem (these already seeded).
        expect(prompt).toContain("seeding is not the problem");
    });
});
