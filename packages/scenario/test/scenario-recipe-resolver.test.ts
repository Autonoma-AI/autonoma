import type { ScenarioRecipe } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { resolveRecipePayload } from "../src/scenario-recipe-resolver";

const TEST_RUN_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_TEST_RUN_ID = "99999999-8888-4777-8666-555555555555";

function recipeWithCreate(create: Record<string, unknown>, variables?: ScenarioRecipe["variables"]): ScenarioRecipe {
    return {
        name: "adminWithProjects",
        description: "An admin and their projects",
        create,
        variables,
        validation: { status: "validated", method: "checkScenario", phase: "ok" },
    };
}

/** The `User` rows of a resolved payload, typed for assertions. */
function users(payload: Record<string, unknown>): Array<Record<string, unknown>> {
    const rows = payload.User;
    if (!Array.isArray(rows)) throw new Error("Expected a User array in the resolved payload");
    return rows;
}

describe("resolveRecipePayload built-in tokens", () => {
    it("substitutes {{testRunId}} with the run id the SDK receives", () => {
        const recipe = recipeWithCreate({ User: [{ externalId: "{{testRunId}}" }] });

        const { createPayload } = resolveRecipePayload(recipe, TEST_RUN_ID);

        expect(users(createPayload)[0]?.externalId).toBe(TEST_RUN_ID);
    });

    it("substitutes {{testRunShortId}} with a short, run-specific value", () => {
        const recipe = recipeWithCreate({ User: [{ username: "admin-{{testRunShortId}}" }] });

        const first = users(resolveRecipePayload(recipe, TEST_RUN_ID).createPayload)[0]?.username;
        const repeat = users(resolveRecipePayload(recipe, TEST_RUN_ID).createPayload)[0]?.username;
        const other = users(resolveRecipePayload(recipe, OTHER_TEST_RUN_ID).createPayload)[0]?.username;

        expect(first).toMatch(/^admin-[0-9a-f]{8}$/);
        expect(repeat).toBe(first);
        expect(other).not.toBe(first);
    });

    it("substitutes a token embedded in a longer string", () => {
        const recipe = recipeWithCreate({ User: [{ email: "owner+{{testRunShortId}}@acme.test" }] });

        const email = users(resolveRecipePayload(recipe, TEST_RUN_ID).createPayload)[0]?.email;

        expect(email).toMatch(/^owner\+[0-9a-f]{8}@acme\.test$/);
    });

    it("records the resolved built-ins so a run can be traced back to the values it seeded", () => {
        const recipe = recipeWithCreate({ User: [{ externalId: "{{testRunId}}" }] });

        const { resolvedVariables } = resolveRecipePayload(recipe, TEST_RUN_ID);

        expect(resolvedVariables.testRunId).toBe(TEST_RUN_ID);
    });

    it("lets an explicitly declared variable win over the built-in of the same name", () => {
        const recipe = recipeWithCreate(
            { User: [{ externalId: "{{testRunId}}" }] },
            {
                testRunId: { strategy: "literal", value: "pinned-value" },
            },
        );

        const { createPayload } = resolveRecipePayload(recipe, TEST_RUN_ID);

        expect(users(createPayload)[0]?.externalId).toBe("pinned-value");
    });

    it("rejects any other token, naming the ones it does substitute", () => {
        const recipe = recipeWithCreate({ User: [{ email: "{{ownerEmail}}" }] });

        expect(() => resolveRecipePayload(recipe, TEST_RUN_ID)).toThrow(
            /Unknown recipe variable: ownerEmail.*\{\{testRunId\}\} and \{\{testRunShortId\}\}/s,
        );
    });
});
