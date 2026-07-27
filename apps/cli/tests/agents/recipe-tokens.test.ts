import { describe, expect, test } from "vitest";
import { findRecipeUploadProblems, type FullRecipeJson } from "../../src/agents/04-recipe-builder/recipe";

function recipeFile(create: Record<string, Array<Record<string, unknown>>>): FullRecipeJson {
    return {
        version: 1,
        source: { discoverPath: "autonoma/discover.json", scenariosPath: "autonoma/scenarios.md" },
        validationMode: "sdk-check",
        recipes: [
            {
                name: "standard",
                description: "An admin and their organization",
                create,
                validation: { status: "validated", method: "checkScenario" },
            },
        ],
    };
}

describe("findRecipeUploadProblems", () => {
    test("accepts a create graph whose only tokens are the built-in run-identity ones", () => {
        const recipe = recipeFile({
            User: [{ email: "admin-{{testRunShortId}}@acme.test", externalId: "{{testRunId}}" }],
        });

        expect(findRecipeUploadProblems(recipe)).toEqual([]);
    });

    test("catches a token the server would reject, naming the scenario and the token", () => {
        const recipe = recipeFile({ User: [{ email: "{{ownerEmail}}" }] });

        const problems = findRecipeUploadProblems(recipe);

        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("standard");
        expect(problems[0]).toContain("{{ownerEmail}}");
    });

    test("catches a token nested deep inside the graph", () => {
        const recipe = recipeFile({ Order: [{ shipping: { address: { city: "{{city}}" } } }] });

        expect(findRecipeUploadProblems(recipe)).toEqual([expect.stringContaining("{{city}}")]);
    });
});
