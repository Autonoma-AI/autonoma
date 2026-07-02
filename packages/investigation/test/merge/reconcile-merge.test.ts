import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { reconcileMerge } from "../../src";
import type { BranchEdit, MainSuiteEntry, RecipeMergeEdit } from "../../src/merge/merge-inputs";
import type { MergePlan, RecipeMergeDecision } from "../../src/merge/schema";

function newTestEdit(ref: string): BranchEdit {
    return { kind: "new_test", ref, name: ref, flow: "Investigation", description: "d", proposedPlan: "plan" };
}

function planModel(plan: MergePlan): MockLanguageModelV3 {
    // The model schema requires mergedPlan on every decision (nullable), so emit it explicitly as the model would.
    const modelShaped = {
        decisions: plan.decisions.map((decision) => ({ ...decision, mergedPlan: decision.mergedPlan ?? null })),
    };
    return new MockLanguageModelV3({
        doGenerate: async () => ({
            content: [{ type: "text", text: JSON.stringify(modelShaped) }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
                inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 50, text: 50, reasoning: 0 },
            },
            warnings: [],
        }),
    });
}

describe("reconcileMerge", () => {
    it("returns an empty plan without calling the model when there are no edits", async () => {
        const model = new MockLanguageModelV3({
            doGenerate: async () => {
                throw new Error("model should not be called for an empty merge");
            },
        });
        const result = await reconcileMerge({ edits: [], mainSuite: [], recipeEdits: [] }, { model });
        expect(result.decisions).toEqual([]);
        expect(model.doGenerateCalls).toHaveLength(0);
    });

    it("returns the model's decisions for the given edits", async () => {
        const plan: MergePlan = {
            decisions: [
                { kind: "new_test", ref: "a", action: "apply", reason: "new coverage" },
                { kind: "new_test", ref: "b", action: "skip", reason: "already covered on main" },
            ],
            recipeDecisions: [],
        };
        const mainSuite: MainSuiteEntry[] = [{ slug: "x", name: "X", flow: "Core", description: "existing" }];

        const result = await reconcileMerge(
            { edits: [newTestEdit("a"), newTestEdit("b")], mainSuite, recipeEdits: [] },
            { model: planModel(plan) },
        );

        expect(result.decisions).toEqual(plan.decisions);
    });

    // Three edits each ~200k chars: no two fit in one 300k-char prompt, so each goes out in its own batch.
    const hugeEdit = (ref: string): BranchEdit => ({ ...newTestEdit(ref), proposedPlan: "x".repeat(200_000) });

    /** Pull the single edit's ref out of a batch prompt (each batch here carries exactly one edit). */
    function refFromPrompt(prompt: unknown): string {
        return JSON.stringify(prompt).match(/ref: (\w+)/)?.[1] ?? "unknown";
    }

    it("batches oversized edit sets across multiple calls and concatenates the decisions in batch order", async () => {
        // The mock echoes the ref it was shown, so order-preservation is tested independent of which concurrent
        // call resolves first - the concatenation must follow batch (edit) order, not execution order.
        const model = new MockLanguageModelV3({
            doGenerate: async (options) => {
                const decisions = [
                    {
                        kind: "new_test",
                        ref: refFromPrompt(options.prompt),
                        action: "apply",
                        reason: "r",
                        mergedPlan: null,
                    },
                ];
                return {
                    content: [{ type: "text", text: JSON.stringify({ decisions }) }],
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 50, text: 50, reasoning: 0 },
                    },
                    warnings: [],
                };
            },
        });

        const result = await reconcileMerge(
            { edits: [hugeEdit("aaa"), hugeEdit("bbb"), hugeEdit("ccc")], mainSuite: [], recipeEdits: [] },
            { model },
        );

        // One model call per batch (three), decisions concatenated in batch order.
        expect(model.doGenerateCalls).toHaveLength(3);
        expect(result.decisions.map((decision) => decision.ref)).toEqual(["aaa", "bbb", "ccc"]);
    });

    it("contains a failing batch - its edits are dropped, the rest still reconcile", async () => {
        // The middle batch (edit "bbb") errors; the other two succeed and their decisions survive.
        const model = new MockLanguageModelV3({
            doGenerate: async (options) => {
                const ref = refFromPrompt(options.prompt);
                if (ref === "bbb") throw new Error("simulated provider error");
                const decisions = [{ kind: "new_test", ref, action: "apply", reason: "r", mergedPlan: null }];
                return {
                    content: [{ type: "text", text: JSON.stringify({ decisions }) }],
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: {
                        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 50, text: 50, reasoning: 0 },
                    },
                    warnings: [],
                };
            },
        });

        const result = await reconcileMerge(
            { edits: [hugeEdit("aaa"), hugeEdit("bbb"), hugeEdit("ccc")], mainSuite: [], recipeEdits: [] },
            { model },
        );

        expect(result.decisions.map((decision) => decision.ref)).toEqual(["aaa", "ccc"]);
    });

    function recipeEdit(scenarioId: string): RecipeMergeEdit {
        return {
            scenarioId,
            scenarioName: `Scenario ${scenarioId}`,
            proposedCreateGraph: '{"orders":[{"total":10}]}',
            baseCreateGraph: '{"orders":[]}',
            mainCreateGraph: '{"orders":[]}',
        };
    }

    /** A mock model returning the given recipe decisions for the recipe reconcile pass (mergedCreateGraph nullable). */
    function recipeModel(decisions: RecipeMergeDecision[]): MockLanguageModelV3 {
        const modelShaped = {
            recipeDecisions: decisions.map((decision) => ({
                ...decision,
                mergedCreateGraph: decision.mergedCreateGraph ?? null,
            })),
        };
        return new MockLanguageModelV3({
            doGenerate: async () => ({
                content: [{ type: "text", text: JSON.stringify(modelShaped) }],
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 50, text: 50, reasoning: 0 },
                },
                warnings: [],
            }),
        });
    }

    it("reconciles recipe edits in their own pass, without a test-edit call", async () => {
        const model = recipeModel([{ scenarioId: "s1", action: "apply", reason: "branch seed still needed" }]);
        const result = await reconcileMerge({ edits: [], mainSuite: [], recipeEdits: [recipeEdit("s1")] }, { model });

        // Only the recipe pass ran (one call); test decisions are empty, recipe decision normalized.
        expect(model.doGenerateCalls).toHaveLength(1);
        expect(result.decisions).toEqual([]);
        expect(result.recipeDecisions).toEqual([
            { scenarioId: "s1", action: "apply", reason: "branch seed still needed", mergedCreateGraph: undefined },
        ]);
    });

    it("returns an empty plan without any model call when there are no edits or recipe edits", async () => {
        const model = new MockLanguageModelV3({
            doGenerate: async () => {
                throw new Error("model should not be called");
            },
        });
        const result = await reconcileMerge({ edits: [], mainSuite: [], recipeEdits: [] }, { model });
        expect(result).toEqual({ decisions: [], recipeDecisions: [] });
        expect(model.doGenerateCalls).toHaveLength(0);
    });
});
