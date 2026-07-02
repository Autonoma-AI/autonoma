import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { diagnoseScenarioFailure } from "../../src/scenario-repair/diagnose";
import type { ScenarioFailureInput } from "../../src/scenario-repair/prompt";

const INPUT: ScenarioFailureInput = {
    testPlan: "assert a user named A is listed",
    recipeCreateGraph: '{ "create": { "User": [{ "name": "B" }] } }',
    failureDetail: "the list showed user B, not A",
};

/** A mock model that emits one diagnosis in the strict (nullable) model shape. */
function diagnosisModel(fields: {
    route: string;
    confidence?: string;
    reasoning?: string;
    testFix?: string | null;
    recipeChange?: string | null;
    factoryIssue?: string | null;
}): MockLanguageModelV3 {
    const shaped = {
        route: fields.route,
        confidence: fields.confidence ?? "high",
        reasoning: fields.reasoning ?? "because",
        testFix: fields.testFix ?? null,
        recipeChange: fields.recipeChange ?? null,
        factoryIssue: fields.factoryIssue ?? null,
    };
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

describe("diagnoseScenarioFailure", () => {
    it("returns a fix_test diagnosis with only the testFix populated", async () => {
        const model = diagnosisModel({
            route: "fix_test",
            testFix: "change the assertion from user A to user B",
            // The model may emit stray off-route fields; they must be cleared.
            recipeChange: "add user A",
        });
        const diagnosis = await diagnoseScenarioFailure(INPUT, { model });
        expect(diagnosis.route).toBe("fix_test");
        expect(diagnosis.testFix).toBe("change the assertion from user A to user B");
        expect(diagnosis.recipeChange).toBeUndefined();
        expect(diagnosis.factoryIssue).toBeUndefined();
    });

    it("keeps recipeChange + factoryIssue for a recipe_and_sdk diagnosis", async () => {
        const model = diagnosisModel({
            route: "recipe_and_sdk",
            recipeChange: "seed an admin user",
            factoryIssue: "the factory cannot create an admin - it lacks the role column",
            testFix: "should be dropped",
        });
        const diagnosis = await diagnoseScenarioFailure(INPUT, { model });
        expect(diagnosis.route).toBe("recipe_and_sdk");
        expect(diagnosis.recipeChange).toBe("seed an admin user");
        expect(diagnosis.factoryIssue).toContain("role column");
        expect(diagnosis.testFix).toBeUndefined();
    });

    it("clears factoryIssue for a recipe_only diagnosis", async () => {
        const model = diagnosisModel({
            route: "recipe_only",
            recipeChange: "add a second document",
            factoryIssue: "not applicable",
        });
        const diagnosis = await diagnoseScenarioFailure(INPUT, { model });
        expect(diagnosis.route).toBe("recipe_only");
        expect(diagnosis.recipeChange).toBe("add a second document");
        expect(diagnosis.factoryIssue).toBeUndefined();
    });

    it("downgrades to unknown when a route is missing its required actionable field", async () => {
        // recipe_and_sdk with no factoryIssue would give slice 1b an empty PR-comment payload - downgrade it.
        const model = diagnosisModel({ route: "recipe_and_sdk", recipeChange: "seed an admin", factoryIssue: null });
        const diagnosis = await diagnoseScenarioFailure(INPUT, { model });
        expect(diagnosis.route).toBe("unknown");
        expect(diagnosis.recipeChange).toBeUndefined();
        expect(diagnosis.factoryIssue).toBeUndefined();
    });

    it("downgrades a fix_test with no testFix to unknown", async () => {
        const model = diagnosisModel({ route: "fix_test", testFix: null });
        const diagnosis = await diagnoseScenarioFailure(INPUT, { model });
        expect(diagnosis.route).toBe("unknown");
        expect(diagnosis.testFix).toBeUndefined();
    });

    it("routes to unknown (contained) when the model call throws", async () => {
        const model = new MockLanguageModelV3({
            doGenerate: async () => {
                throw new Error("provider exploded");
            },
        });
        const diagnosis = await diagnoseScenarioFailure(INPUT, { model });
        expect(diagnosis.route).toBe("unknown");
        expect(diagnosis.confidence).toBe("low");
    });
});
