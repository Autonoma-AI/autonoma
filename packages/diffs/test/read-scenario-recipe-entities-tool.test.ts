import { describe, expect, it } from "vitest";
import { ReadScenarioRecipeEntitiesTool } from "../src/agents/tools/scenario/read-scenario-recipe-entities-tool";
import type { ScenarioEntityRecord } from "../src/scenario-data";
import type { ScenarioRecipeData } from "../src/scenario-recipe";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeDiffsLoop } from "./test-loops";

const scenarioRecipes: ScenarioRecipeData[] = [
    {
        scenarioId: "scn-1",
        scenarioName: "authenticated-admin",
        entities: {
            User: [
                { _alias: "admin", email: "admin+{{testRunId}}@example.com", role: "admin" },
                { _alias: "member", email: "member@example.test", role: "member" },
            ],
            Workspace: [{ _alias: "ws", name: "Acme", ownerId: { _ref: "admin" } }],
        },
    },
    {
        scenarioId: "scn-2",
        scenarioName: "empty-workspace",
        entities: { User: [{ _alias: "owner", email: "owner@example.test" }] },
    },
];

type ReadResult = { scenario: string; entityType: string; count: number; records: ScenarioEntityRecord[] };

describe("read_scenario_recipe_entities tool", () => {
    it("returns every declared record for a known scenario + entity type", async () => {
        const loop = makeDiffsLoop({ scenarioRecipes });
        const tool = new ReadScenarioRecipeEntitiesTool();

        const result = await executeTool<ToolEnvelope<ReadResult>>(
            tool,
            { scenario: "authenticated-admin", entityType: "User" },
            loop,
        );

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("expected success");
        expect(result.result.scenario).toBe("authenticated-admin");
        expect(result.result.entityType).toBe("User");
        expect(result.result.count).toBe(2);
        expect(result.result.records).toEqual(scenarioRecipes[0]?.entities.User);
    });

    it("fails with the available scenarios when the scenario is unknown", async () => {
        const loop = makeDiffsLoop({ scenarioRecipes });
        const tool = new ReadScenarioRecipeEntitiesTool();

        const result = await executeTool<ToolEnvelope<ReadResult>>(
            tool,
            { scenario: "no-such-scenario", entityType: "User" },
            loop,
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("no-such-scenario");
        expect(result.fixSuggestion).toContain("authenticated-admin");
        expect(result.fixSuggestion).toContain("empty-workspace");
    });

    it("fails with the scenario's available types when the entity type is unknown", async () => {
        const loop = makeDiffsLoop({ scenarioRecipes });
        const tool = new ReadScenarioRecipeEntitiesTool();

        const result = await executeTool<ToolEnvelope<ReadResult>>(
            tool,
            { scenario: "empty-workspace", entityType: "Workspace" },
            loop,
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("Workspace");
        expect(result.fixSuggestion).toContain("User");
    });

    it("truncates pathologically large record sets with a marker, keeping count accurate", async () => {
        const bigRecords = Array.from({ length: 2000 }, (_unused, index) => ({
            _alias: `item-${index}`,
            blob: "x".repeat(200),
        }));
        const loop = makeDiffsLoop({
            scenarioRecipes: [{ scenarioId: "scn-big", scenarioName: "big", entities: { Item: bigRecords } }],
        });
        const tool = new ReadScenarioRecipeEntitiesTool();

        const result = await executeTool<ToolEnvelope<ReadResult & { truncated?: boolean; note?: string }>>(
            tool,
            { scenario: "big", entityType: "Item" },
            loop,
        );

        if (!result.success) throw new Error("expected success");
        expect(result.result.count).toBe(2000);
        expect(result.result.truncated).toBe(true);
        expect(result.result.records.length).toBeLessThan(2000);
        expect(result.result.records.length).toBeGreaterThan(0);
        expect(result.result.note).toContain("output budget");
    });

    it("fails gracefully when the analysis has no resolved recipes", async () => {
        const loop = makeDiffsLoop();
        const tool = new ReadScenarioRecipeEntitiesTool();

        const result = await executeTool<ToolEnvelope<ReadResult>>(
            tool,
            { scenario: "authenticated-admin", entityType: "User" },
            loop,
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("no scenarios with a usable recipe");
    });
});
