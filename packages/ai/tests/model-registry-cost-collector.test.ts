import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { CostCollector } from "../src/registry/cost-collector";
import { simpleCostFunction } from "../src/registry/costs";
import type { ModelEntry } from "../src/registry/model-entries";
import { type LanguageModel, ModelRegistry } from "../src/registry/model-registry";

function fakeModelEntry(): ModelEntry {
    const model: LanguageModel = new MockLanguageModelV3({
        modelId: "fake-model",
        provider: "fake-provider",
        doGenerate: async () => ({
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
                inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 500_000, text: 500_000, reasoning: 0 },
            },
            warnings: [],
        }),
    });

    return {
        createModel: () => model,
        // $1/M input, $2/M output -> 1M input ($1) + 500K output ($1) = $2 = 2_000_000 microdollars
        pricing: simpleCostFunction({ inputCostPerM: 1, outputCostPerM: 2 }),
    };
}

function buildRegistry(): ModelRegistry<"fake"> {
    return new ModelRegistry<"fake">({ models: { fake: fakeModelEntry() } });
}

describe("ModelRegistry per-call cost collector", () => {
    it("captures a cost record for a model issued by getModel", async () => {
        const collector = new CostCollector();
        const registry = buildRegistry();

        const model = registry.getModel({ model: "fake", tag: "my-tag" }, collector);

        await model.doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });

        const records = collector.getRecords();
        expect(records).toHaveLength(1);
        expect(records[0]?.model).toBe("fake-model");
        expect(records[0]?.tag).toBe("my-tag");
        expect(records[0]?.inputTokens).toBe(1_000_000);
        expect(records[0]?.outputTokens).toBe(500_000);
        expect(records[0]?.costMicrodollars).toBe(2_000_000);
    });

    it("does not capture into a collector when none is supplied", async () => {
        const collector = new CostCollector();
        const registry = buildRegistry();

        const model = registry.getModel({ model: "fake", tag: "my-tag" });

        await model.doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });

        expect(collector.getRecords()).toHaveLength(0);
    });

    it("composes a per-call collector with construction-time monitoring", async () => {
        const constructionCollector = new CostCollector();
        const perCallCollector = new CostCollector();
        const registry = new ModelRegistry<"fake">({
            models: { fake: fakeModelEntry() },
            monitoring: constructionCollector.createMonitoringCallbacks(),
        });

        const model = registry.getModel({ model: "fake", tag: "my-tag" }, perCallCollector);

        await model.doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });

        expect(constructionCollector.getRecords()).toHaveLength(1);
        expect(perCallCollector.getRecords()).toHaveLength(1);
    });

    it("captures separate records per getModel call sharing one collector", async () => {
        const collector = new CostCollector();
        const registry = buildRegistry();

        const first = registry.getModel({ model: "fake", tag: "first" }, collector);
        const second = registry.getModel({ model: "fake", tag: "second" }, collector);

        await first.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "a" }] }] });
        await second.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "b" }] }] });

        const records = collector.getRecords();
        expect(records).toHaveLength(2);
        expect(records.map((r) => r.tag)).toEqual(["first", "second"]);
    });
});
