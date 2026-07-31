import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecipeContext } from "../../src/agents/05-test-generator/recipe-context";

async function withRecipe(recipe: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "recipe-ctx-"));
    if (recipe !== undefined) {
        await writeFile(join(dir, "recipe.json"), JSON.stringify(recipe), "utf-8");
    }
    return loadRecipeContext(dir);
}

const RECIPE = {
    recipes: [
        {
            name: "standard",
            description: "A demo customer with two accounts.",
            create: {
                User: [{ _alias: "user_demo", email: "demo+{{testRunId}}@example.com", name: "Demo User" }],
                Account: [{ _alias: "acct", userId: { _ref: "user_demo" }, type: "checking", balance: 12450.5 }],
            },
        },
    ],
};

describe("loadRecipeContext", () => {
    it("renders exact data values a test can assert", async () => {
        const out = await withRecipe(RECIPE);

        expect(out).toContain("12450.5");
        expect(out).toContain('name="Demo User"');
        expect(out).toContain("A demo customer with two accounts.");
    });

    it("masks per-run templated values instead of exposing an unassertable literal", async () => {
        const out = await withRecipe(RECIPE);

        // The literal would be asserted verbatim by a model that saw it, and the
        // rendered email differs every run - this is the drift that produced tests
        // asserting an address that never exists.
        expect(out).not.toContain("demo+{{testRunId}}@example.com");
        expect(out).not.toContain("{{testRunId}}");
        expect(out).toContain("<generated per run>");
    });

    it("keeps aliases so cross-row references resolve", async () => {
        const out = await withRecipe(RECIPE);

        expect(out).toContain("user_demo:");
        expect(out).toContain("the row aliased user_demo");
    });

    it("returns empty when there is no recipe, so the caller can fall back", async () => {
        const dir = await mkdtemp(join(tmpdir(), "recipe-ctx-"));

        expect(await loadRecipeContext(dir)).toBe("");
    });

    it("returns empty on a malformed recipe rather than throwing mid-run", async () => {
        expect(await withRecipe({ notARecipe: true })).toBe("");
    });
});
