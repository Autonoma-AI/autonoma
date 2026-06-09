import { describe, expect, it } from "vitest";
import type { ScenarioRecipeData } from "../src/scenario-recipe";
import { summarizeScenarioRecipes } from "../src/scenario-recipe";

describe("summarizeScenarioRecipes", () => {
    it("returns undefined when there are no recipes", () => {
        expect(summarizeScenarioRecipes([])).toBeUndefined();
    });

    it("renders one block per scenario with template framing and per-type previews", () => {
        const recipes: ScenarioRecipeData[] = [
            {
                scenarioId: "scn-1",
                scenarioName: "authenticated-admin",
                description: "Logged-in admin with one workspace",
                entities: {
                    User: [{ _alias: "admin", email: "admin+{{testRunId}}@example.com", role: "admin" }],
                },
            },
        ];

        const summary = summarizeScenarioRecipes(recipes);

        expect(summary).toBeDefined();
        if (summary == null) throw new Error("expected a summary");
        // Frames the data as a template, not a per-run instance.
        expect(summary).toContain("recipe template");
        expect(summary).toContain("before any replay");
        expect(summary).toContain("## Scenario: authenticated-admin");
        expect(summary).toContain("Logged-in admin with one workspace");
        expect(summary).toContain("### User - 1 record");
        // Unresolved placeholders survive into the summary.
        expect(summary).toContain("admin+{{testRunId}}@example.com");
        expect(summary).toContain("read_scenario_recipe_entities");
    });

    it("names the scenario in the per-type overflow hint so the tool call is unambiguous", () => {
        const records = Array.from({ length: 25 }, (_unused, index) => ({
            _alias: `item-${index}`,
            name: `Item ${index}`,
        }));
        const recipes: ScenarioRecipeData[] = [
            { scenarioId: "scn-1", scenarioName: "big-catalog", entities: { Item: records } },
        ];

        const summary = summarizeScenarioRecipes(recipes);
        if (summary == null) throw new Error("expected a summary");

        expect(summary).toContain("### Item - 25 records");
        expect(summary).toContain("`item-19` - name: Item 19");
        expect(summary).not.toContain("`item-20`");
        expect(summary).toContain('...and 5 more. Call `read_scenario_recipe_entities("big-catalog", "Item")`');
    });

    it("escapes a scenario name containing a quote so the overflow tool call stays well-formed", () => {
        const records = Array.from({ length: 25 }, (_unused, index) => ({ _alias: `item-${index}` }));
        const recipes: ScenarioRecipeData[] = [
            { scenarioId: "scn-1", scenarioName: 'odd "quoted" name', entities: { Item: records } },
        ];

        const summary = summarizeScenarioRecipes(recipes);
        if (summary == null) throw new Error("expected a summary");

        // The args are JSON-escaped, so the inner quotes are backslash-escaped
        // rather than prematurely closing the string literal.
        expect(summary).toContain('read_scenario_recipe_entities("odd \\"quoted\\" name", "Item")');
    });

    it("renders multiple scenarios in order", () => {
        const recipes: ScenarioRecipeData[] = [
            { scenarioId: "scn-a", scenarioName: "alpha", entities: { User: [{ _alias: "a" }] } },
            { scenarioId: "scn-b", scenarioName: "beta", entities: { User: [{ _alias: "b" }] } },
        ];

        const summary = summarizeScenarioRecipes(recipes);
        if (summary == null) throw new Error("expected a summary");

        expect(summary.indexOf("## Scenario: alpha")).toBeLessThan(summary.indexOf("## Scenario: beta"));
    });
});
