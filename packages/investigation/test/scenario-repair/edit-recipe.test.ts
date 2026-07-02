import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { editRecipeCreateGraph } from "../../src";
import type { RecipeEditInput } from "../../src";

const INPUT: RecipeEditInput = {
    currentCreateGraph: '{"Project":[{"_alias":"p1","name":"Existing"}]}',
    recipeChange: "seed a second project named Annual Upkeep",
    failureDetail: "the search matched nothing",
};

/** A mock model that emits one recipe edit in the strict (createGraphJson + summary) shape. */
function editorModel(fields: { createGraphJson: string; summary?: string }): MockLanguageModelV3 {
    const shaped = { createGraphJson: fields.createGraphJson, summary: fields.summary ?? "changed it" };
    return new MockLanguageModelV3({
        doGenerate: async () => ({
            content: [{ type: "text", text: JSON.stringify(shaped) }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
                inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 50, text: 50, reasoning: 0 },
            },
            warnings: [],
        }),
    });
}

describe("editRecipeCreateGraph", () => {
    it("parses the model's JSON string into a validated create-graph object", async () => {
        const model = editorModel({
            createGraphJson: '{"Project":[{"_alias":"p1","name":"Existing"},{"_alias":"p2","name":"Annual Upkeep"}]}',
            summary: "added a second project",
        });
        const edit = await editRecipeCreateGraph(INPUT, { model });
        expect(edit.summary).toBe("added a second project");
        expect(edit.createGraph).toEqual({
            Project: [
                { _alias: "p1", name: "Existing" },
                { _alias: "p2", name: "Annual Upkeep" },
            ],
        });
    });

    it("throws when the model returns invalid JSON (so the caller skips the repair)", async () => {
        const model = editorModel({ createGraphJson: "{not json" });
        await expect(editRecipeCreateGraph(INPUT, { model })).rejects.toThrow();
    });

    it("throws when the edited graph is not an object (a bare array is not a create graph)", async () => {
        const model = editorModel({ createGraphJson: "[1,2,3]" });
        await expect(editRecipeCreateGraph(INPUT, { model })).rejects.toThrow();
    });
});
