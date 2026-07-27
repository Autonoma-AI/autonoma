import { describe, expect, it } from "vitest";
import { ScenarioRecipesFileSchema, findRecipeCreateGraphProblems, findUnknownRecipeTokens } from "./scenarios";

const baseRecipe = {
    name: "standard",
    description: "Standard scenario",
    create: {
        Organization: [{ name: "Acme Corp" }],
    },
    validation: {
        status: "validated",
        method: "checkScenario",
        phase: "ok",
    },
};

const baseFile = {
    version: 1,
    source: {
        discoverPath: "autonoma/discover.json",
        scenariosPath: "autonoma/scenarios.md",
    },
    validationMode: "sdk-check",
};

describe("ScenarioRecipesFileSchema", () => {
    it("accepts concrete recipes without variables", () => {
        const result = ScenarioRecipesFileSchema.safeParse({
            ...baseFile,
            recipes: [baseRecipe],
        });

        expect(result.success).toBe(true);
    });

    it("accepts recipes with typed variables", () => {
        const result = ScenarioRecipesFileSchema.safeParse({
            ...baseFile,
            recipes: [
                {
                    ...baseRecipe,
                    create: {
                        User: [{ email: "{{owner_email}}", firstName: "{{owner_first_name}}" }],
                    },
                    variables: {
                        owner_email: {
                            strategy: "derived",
                            source: "testRunId",
                            format: "owner+{testRunId}@example.com",
                        },
                        owner_first_name: {
                            strategy: "faker",
                            generator: "person.firstName",
                        },
                    },
                },
            ],
        });

        expect(result.success).toBe(true);
    });

    it("rejects invalid variable strategy definitions", () => {
        const result = ScenarioRecipesFileSchema.safeParse({
            ...baseFile,
            recipes: [
                {
                    ...baseRecipe,
                    variables: {
                        owner_email: {
                            strategy: "custom",
                        },
                    },
                },
            ],
        });

        expect(result.success).toBe(false);
    });
});

describe("findRecipeCreateGraphProblems", () => {
    it("accepts a graph whose refs resolve and whose only tokens are built in", () => {
        const problems = findRecipeCreateGraphProblems({
            Organization: [{ _alias: "org", name: "Acme" }],
            User: [{ email: "admin-{{testRunShortId}}@acme.test", organizationId: { _ref: "org" } }],
        });

        expect(problems).toEqual([]);
    });

    it("reports a shape the environment factory cannot read, and stops there", () => {
        const problems = findRecipeCreateGraphProblems({ User: { email: "admin@acme.test" } });

        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("array of records");
    });

    it("reports a _ref that matches no _alias", () => {
        const problems = findRecipeCreateGraphProblems({ User: [{ organizationId: { _ref: "org" } }] });

        expect(problems).toEqual([expect.stringContaining("org")]);
    });

    it("reports tokens that resolve to nothing, naming the ones that do", () => {
        const problems = findRecipeCreateGraphProblems({ User: [{ email: "{{ownerEmail}}" }] });

        expect(problems).toEqual([expect.stringContaining("{{ownerEmail}}")]);
        expect(problems[0]).toContain("{{testRunId}}");
    });

    it("reports every problem at once so one round trip fixes them all", () => {
        const problems = findRecipeCreateGraphProblems({
            User: [{ email: "{{ownerEmail}}", organizationId: { _ref: "org" } }],
        });

        expect(problems).toHaveLength(2);
    });
});

describe("findUnknownRecipeTokens", () => {
    it("finds tokens nested anywhere and deduplicates them", () => {
        const tokens = findUnknownRecipeTokens({
            Order: [{ city: "{{city}}", shipping: { address: { city: "{{city}}", zip: "{{zip}}" } } }],
        });

        expect(tokens).toEqual(["city", "zip"]);
    });

    it("ignores the built-in tokens", () => {
        expect(findUnknownRecipeTokens("admin-{{testRunShortId}}-{{testRunId}}")).toEqual([]);
    });
});
