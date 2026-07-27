import type { ScenarioRecipe } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { findRecipeProblems } from "../src/find-recipe-problems";

function recipeWithCreate(create: Record<string, unknown>): ScenarioRecipe {
    return {
        name: "adminWithProjects",
        description: "An admin and their projects",
        create,
        validation: { status: "validated", method: "checkScenario", phase: "ok" },
    };
}

describe("findRecipeProblems", () => {
    it("passes a recipe whose refs resolve and whose only tokens are built-in", () => {
        const recipe = recipeWithCreate({
            Organization: [{ _alias: "org", name: "Acme" }],
            User: [{ email: "admin-{{testRunShortId}}@acme.test", organizationId: { _ref: "org" } }],
        });

        expect(findRecipeProblems(recipe)).toEqual([]);
    });

    it("passes a stored recipe whose tokens its own variables block declares", () => {
        const recipe: ScenarioRecipe = {
            ...recipeWithCreate({ User: [{ firstName: "{{owner_first_name}}" }] }),
            variables: { owner_first_name: { strategy: "faker", generator: "person.firstName" } },
        };

        expect(findRecipeProblems(recipe)).toEqual([]);
    });

    it("reports a variables block that cannot resolve, which only the rehearsal sees", () => {
        const recipe: ScenarioRecipe = {
            ...recipeWithCreate({ User: [{ firstName: "{{owner_first_name}}" }] }),
            variables: { owner_first_name: { strategy: "faker", generator: "person.nickname" } },
        };

        expect(findRecipeProblems(recipe)).toEqual([expect.stringContaining("person.nickname")]);
    });

    it("reports a token that will not resolve at provisioning time", () => {
        const recipe = recipeWithCreate({ User: [{ email: "{{ownerEmail}}" }] });

        expect(findRecipeProblems(recipe)).toEqual([expect.stringContaining("ownerEmail")]);
    });

    it("reports a _ref that points at no _alias", () => {
        const recipe = recipeWithCreate({
            User: [{ email: "admin@acme.test", organizationId: { _ref: "org" } }],
        });

        expect(findRecipeProblems(recipe)).toEqual([expect.stringContaining("org")]);
    });

    it("reports a create graph the environment factory cannot read", () => {
        const recipe = recipeWithCreate({ User: { email: "admin@acme.test" } });

        expect(findRecipeProblems(recipe)).toEqual([expect.stringContaining("array of records")]);
    });

    it("reports every problem at once so one round trip fixes them all", () => {
        const recipe = recipeWithCreate({
            User: [{ email: "{{ownerEmail}}", organizationId: { _ref: "org" } }],
        });

        expect(findRecipeProblems(recipe)).toHaveLength(2);
    });
});
