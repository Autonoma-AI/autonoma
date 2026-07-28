import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScenarioRecipesFileSchema } from "@autonoma/types";
import { describe, expect, test } from "vitest";
import {
    findRecipeUploadProblems,
    type FullRecipeJson,
    loadRecipe,
    RECIPE_FILE,
} from "../../src/agents/04-recipe-builder/recipe";

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
                validation: { status: "validated", method: "checkScenario", phase: "ok" },
            },
        ],
    };
}

/** Write a recipe.json the coding agent could plausibly have produced, and read it back. */
async function readWritten(json: unknown) {
    const dir = await mkdtemp(join(tmpdir(), "autonoma-recipe-"));
    await writeFile(join(dir, RECIPE_FILE), JSON.stringify(json), "utf-8");
    return { dir, read: await loadRecipe(dir) };
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

    test("accepts a token the recipe declares itself in its variables block", () => {
        const recipe = recipeFile({ User: [{ email: "{{ownerEmail}}" }] });
        recipe.recipes[0]!.variables = { ownerEmail: { strategy: "literal", value: "owner@acme.test" } };

        expect(findRecipeUploadProblems(recipe)).toEqual([]);
    });
});

describe("loadRecipe", () => {
    test("what it returns is accepted verbatim by the upload contract", async () => {
        // The envelope the integration prompt tells the coding agent to write.
        const { read } = await readWritten({
            version: 1,
            source: { discoverPath: "discover.json", scenariosPath: "scenarios.md" },
            validationMode: "endpoint-lifecycle",
            recipes: [
                {
                    name: "standard",
                    description: "An admin and their organization",
                    create: { User: [{ _alias: "admin", email: "admin-{{testRunShortId}}@acme.test" }] },
                    validation: { status: "validated", method: "endpoint-up-down" },
                },
            ],
        });

        expect(read.status).toBe("ok");
        if (read.status !== "ok") return;
        expect(ScenarioRecipesFileSchema.safeParse(read.recipe).success).toBe(true);
    });

    test("keeps a variables block the author declared", async () => {
        const { read } = await readWritten({
            version: 1,
            source: { discoverPath: "discover.json", scenariosPath: "scenarios.md" },
            validationMode: "endpoint-lifecycle",
            recipes: [
                {
                    name: "standard",
                    description: "An admin",
                    create: { User: [{ email: "{{ownerEmail}}" }] },
                    variables: { ownerEmail: { strategy: "literal", value: "owner@acme.test" } },
                    validation: { status: "validated", method: "endpoint-up-down", phase: "ok" },
                },
            ],
        });

        expect(read.status).toBe("ok");
        if (read.status !== "ok") return;
        expect(read.recipe.recipes[0]?.variables).toEqual({
            ownerEmail: { strategy: "literal", value: "owner@acme.test" },
        });
    });

    test("reports a malformed recipe as invalid with the offending field, not as missing", async () => {
        const { read } = await readWritten({
            version: 1,
            source: { discoverPath: "discover.json" },
            validationMode: "endpoint-lifecycle",
            recipes: [
                {
                    name: "standard",
                    description: "An admin",
                    create: { User: [{ email: "admin@acme.test" }] },
                    validation: { status: "validated", method: "endpoint-up-down", phase: "ok" },
                },
            ],
        });

        expect(read.status).toBe("invalid");
        if (read.status !== "invalid") return;
        expect(read.problems.join("\n")).toContain("source.scenariosPath");
    });

    test("reports an absent file as absent", async () => {
        const dir = await mkdtemp(join(tmpdir(), "autonoma-recipe-"));

        expect(await loadRecipe(dir)).toEqual({ status: "absent" });
    });
});
