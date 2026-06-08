import { describe, expect, it } from "vitest";
import { ReadScenarioEntitiesTool } from "../src/agents/tools/scenario/read-scenario-entities-tool";
import type { ScenarioData, ScenarioEntityRecord } from "../src/scenario-data";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeReviewerLoop } from "./test-loops";

const scenarioData: ScenarioData = {
    scenarioName: "Org with users and projects",
    entities: {
        User: [
            { _alias: "owner", email: "owner@example.test", name: "Pat Owner" },
            { _alias: "member", email: "member@example.test", name: "Sam Member" },
        ],
        Project: [{ _alias: "proj", name: "Apollo", ownerId: { _ref: "owner" } }],
    },
};

type ReadResult = { entityType: string; count: number; records: ScenarioEntityRecord[] };

describe("read_scenario_entities tool", () => {
    it("returns every full record for a known entity type", async () => {
        const loop = makeReviewerLoop({ scenarioData });
        const tool = new ReadScenarioEntitiesTool();

        const result = await executeTool<ToolEnvelope<ReadResult>>(tool, { entityType: "User" }, loop);

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("expected success");
        expect(result.result.entityType).toBe("User");
        expect(result.result.count).toBe(2);
        expect(result.result.records).toEqual(scenarioData.entities.User);
    });

    it("fails with the available types when the entity type is unknown", async () => {
        const loop = makeReviewerLoop({ scenarioData });
        const tool = new ReadScenarioEntitiesTool();

        const result = await executeTool<ToolEnvelope<ReadResult>>(tool, { entityType: "Invoice" }, loop);

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("Invoice");
        expect(result.fixSuggestion).toContain("User");
        expect(result.fixSuggestion).toContain("Project");
    });

    it("truncates pathologically large record sets with a marker, keeping count accurate", async () => {
        const bigRecords = Array.from({ length: 2000 }, (_unused, index) => ({
            _alias: `item-${index}`,
            blob: "x".repeat(200),
        }));
        const loop = makeReviewerLoop({ scenarioData: { scenarioName: "Big", entities: { Item: bigRecords } } });
        const tool = new ReadScenarioEntitiesTool();

        const result = await executeTool<ToolEnvelope<ReadResult & { truncated?: boolean; note?: string }>>(
            tool,
            { entityType: "Item" },
            loop,
        );

        if (!result.success) throw new Error("expected success");
        expect(result.result.count).toBe(2000);
        expect(result.result.truncated).toBe(true);
        expect(result.result.records.length).toBeLessThan(2000);
        expect(result.result.records.length).toBeGreaterThan(0);
        expect(result.result.note).toContain("output budget");
    });

    it("fails gracefully when the run has no scenario data", async () => {
        const loop = makeReviewerLoop();
        const tool = new ReadScenarioEntitiesTool();

        const result = await executeTool<ToolEnvelope<ReadResult>>(tool, { entityType: "User" }, loop);

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("no resolved scenario data");
    });
});
