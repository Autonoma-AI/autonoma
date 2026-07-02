import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { repairRecipeWithAgent, toRecipeRepairResult } from "../../src";
import type { RepairRecipeDeps, RepairRecipeInput } from "../../src";

const VALID_GRAPH = '{"Project":[{"_alias":"p1","name":"Existing"},{"_alias":"p2","name":"Annual Upkeep"}]}';

/** The model's decision object, in the nullable-required shape the agent's structured output uses. */
function decision(fields: {
    route: "fix_test" | "recipe_only" | "recipe_and_sdk" | "unknown";
    createGraphJson?: string;
    summary?: string;
    factoryIssue?: string;
    handoff?: string;
}): Parameters<typeof toRecipeRepairResult>[0] {
    return {
        route: fields.route,
        confidence: "high",
        reasoning: "because",
        createGraphJson: fields.createGraphJson ?? null,
        summary: fields.summary ?? null,
        factoryIssue: fields.factoryIssue ?? null,
        handoff: fields.handoff ?? null,
    };
}

describe("toRecipeRepairResult", () => {
    it("keeps a schema-valid candidate for a recipe_only route", () => {
        const result = toRecipeRepairResult(
            decision({ route: "recipe_only", createGraphJson: VALID_GRAPH, summary: "added a project" }),
        );
        expect(result.route).toBe("recipe_only");
        expect(result.createGraphJson).toBe(VALID_GRAPH);
        expect(result.summary).toBe("added a project");
        expect(result.handoff).toBeUndefined();
    });

    it("drops a candidate that fails validation and explains why in the handoff", () => {
        // A bare array is not a create graph; the candidate must be dropped so nothing broken is staged.
        const result = toRecipeRepairResult(decision({ route: "recipe_only", createGraphJson: "[1,2,3]" }));
        expect(result.createGraphJson).toBeUndefined();
        expect(result.handoff).toBeDefined();
        expect(result.handoff).toContain("failed validation");
    });

    it("drops a candidate with a dangling _ref (referential validation)", () => {
        const dangling = '{"Task":[{"_alias":"t1","project":{"_ref":"missing"}}]}';
        const result = toRecipeRepairResult(decision({ route: "recipe_only", createGraphJson: dangling }));
        expect(result.createGraphJson).toBeUndefined();
        expect(result.handoff).toContain("failed validation");
    });

    it("clears an off-route candidate for fix_test (a test fix carries no recipe)", () => {
        const result = toRecipeRepairResult(decision({ route: "fix_test", createGraphJson: VALID_GRAPH }));
        expect(result.createGraphJson).toBeUndefined();
        expect(result.factoryIssue).toBeUndefined();
    });

    it("keeps both the candidate and the factoryIssue for recipe_and_sdk", () => {
        const result = toRecipeRepairResult(
            decision({
                route: "recipe_and_sdk",
                createGraphJson: VALID_GRAPH,
                factoryIssue: "add a Project.archived field",
            }),
        );
        expect(result.createGraphJson).toBe(VALID_GRAPH);
        expect(result.factoryIssue).toBe("add a Project.archived field");
    });

    it("only surfaces factoryIssue on the recipe_and_sdk route", () => {
        const result = toRecipeRepairResult(
            decision({ route: "recipe_only", createGraphJson: VALID_GRAPH, factoryIssue: "ignored" }),
        );
        expect(result.factoryIssue).toBeUndefined();
    });

    it("carries a give-up handoff when the agent produces no recipe", () => {
        const result = toRecipeRepairResult(
            decision({ route: "unknown", handoff: "tried X and Y, both rejected by the factory" }),
        );
        expect(result.createGraphJson).toBeUndefined();
        expect(result.handoff).toBe("tried X and Y, both rejected by the factory");
    });
});

const INPUT: RepairRecipeInput = {
    appSlug: "acme",
    prNumber: 42,
    slug: "search-finds-project",
    currentCreateGraph: '{"Project":[{"_alias":"p1","name":"Existing"}]}',
    recipeChange: "seed a second project named Annual Upkeep",
    failureDetail: "the search matched nothing",
    testPlan: "search for Annual Upkeep and assert it appears",
};

/** A model that returns free-text on the tool-loop call, then the structured decision on the Output.object call. */
function twoPhaseModel(decisionText: string): MockLanguageModelV3 {
    let call = 0;
    return new MockLanguageModelV3({
        doGenerate: async () => {
            call += 1;
            const text = call === 1 ? "I read the factory code and validated a candidate." : decisionText;
            return {
                content: [{ type: "text", text }],
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 50, text: 50, reasoning: 0 },
                },
                warnings: [],
            };
        },
    });
}

/** Build agent deps with inert codebase/preview fakes and an optional dry-run-seed capability. */
function depsWith(model: MockLanguageModelV3, dryRunSeed?: RepairRecipeDeps["dryRunSeed"]): RepairRecipeDeps {
    return {
        codebase: { readFile: async () => "", grep: async () => "", diff: async () => "", diffStat: async () => "" },
        preview: { getEnvVarNames: async () => [], runScript: async () => "" },
        dryRunSeed,
        model,
        maxSteps: 4,
    };
}

describe("repairRecipeWithAgent", () => {
    it("returns the agent's validated candidate through the investigate-then-decide loop", async () => {
        const model = twoPhaseModel(
            JSON.stringify(
                decision({ route: "recipe_only", createGraphJson: VALID_GRAPH, summary: "added a project" }),
            ),
        );
        const result = await repairRecipeWithAgent(INPUT, depsWith(model));
        expect(result.route).toBe("recipe_only");
        expect(result.createGraphJson).toBe(VALID_GRAPH);
    });

    it("returns a handoff (no candidate) when the agent could not produce a valid recipe", async () => {
        const model = twoPhaseModel(
            JSON.stringify(decision({ route: "unknown", handoff: "the factory cannot create archived projects" })),
        );
        const result = await repairRecipeWithAgent(INPUT, depsWith(model));
        expect(result.createGraphJson).toBeUndefined();
        expect(result.handoff).toContain("archived projects");
    });

    it("keeps the candidate when the confirming dry-run accepts it", async () => {
        const model = twoPhaseModel(
            JSON.stringify(
                decision({ route: "recipe_only", createGraphJson: VALID_GRAPH, summary: "added a project" }),
            ),
        );
        const result = await repairRecipeWithAgent(
            INPUT,
            depsWith(model, async () => ({ ok: true, detail: "seeded" })),
        );
        expect(result.createGraphJson).toBe(VALID_GRAPH);
    });

    it("drops the candidate to a handoff when the confirming dry-run rejects it", async () => {
        // Guards the two-phase gap: the decision model re-emits the candidate from memory, so the final graph must
        // be re-seeded against the real factory - not just locally re-validated - before it can be staged.
        const model = twoPhaseModel(
            JSON.stringify(
                decision({ route: "recipe_only", createGraphJson: VALID_GRAPH, summary: "added a project" }),
            ),
        );
        const result = await repairRecipeWithAgent(
            INPUT,
            depsWith(model, async () => ({ ok: false, detail: "unknown field Project.archived" })),
        );
        expect(result.createGraphJson).toBeUndefined();
        expect(result.handoff).toContain("rejected by the factory");
        expect(result.handoff).toContain("Project.archived");
    });
});
