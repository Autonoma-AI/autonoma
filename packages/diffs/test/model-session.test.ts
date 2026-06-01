import { MODEL_ENTRIES } from "@autonoma/ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { openModelSession } from "../src/ai/model-session";

const GEMINI_3_FLASH_MODEL_ID = "gemini-3-flash-preview";

/**
 * A mock model standing in for Gemini 3 Flash so the session can be exercised offline. It reports a
 * fixed usage so the per-call cost record is deterministic; the registry still applies the real
 * Gemini pricing function to it.
 */
function mockSmartVisualModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        modelId: GEMINI_3_FLASH_MODEL_ID,
        provider: "google",
        doGenerate: async () => ({
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
                inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 500, text: 500, reasoning: 0 },
            },
            warnings: [],
        }),
    });
}

describe("openModelSession", () => {
    let createModelSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
        // Inject a mock model into the lazily-built singleton by stubbing the entry's factory, then
        // trigger construction so every test below operates on the same memoized registry.
        createModelSpy = vi
            .spyOn(MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW, "createModel")
            .mockReturnValue(mockSmartVisualModel());
        openModelSession();
    });

    it("maps smart-visual to Gemini 3 Flash", () => {
        const session = openModelSession();

        const model = session.getModel({ model: "smart-visual", tag: "match-bug" });

        expect(model.modelId).toBe(GEMINI_3_FLASH_MODEL_ID);
    });

    it("reuses the same registry instance across sessions", () => {
        // The factory was invoked once when the singleton was first built in beforeAll. Opening more
        // sessions must not reconstruct the registry, so it is never invoked again.
        const callsAfterConstruction = createModelSpy.mock.calls.length;

        openModelSession();
        openModelSession();

        expect(createModelSpy.mock.calls.length).toBe(callsAfterConstruction);
    });

    it("gives each session its own cost collector", () => {
        const first = openModelSession();
        const second = openModelSession();

        expect(first.costCollector).not.toBe(second.costCollector);
        expect(first.costCollector.getRecords()).toHaveLength(0);
        expect(second.costCollector.getRecords()).toHaveLength(0);
    });

    it("meters every getModel call into the session's collector", async () => {
        const session = openModelSession();

        const model = session.getModel({ model: "smart-visual", tag: "match-bug" });
        await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });

        const records = session.costCollector.getRecords();
        expect(records).toHaveLength(1);
        expect(records[0]?.model).toBe(GEMINI_3_FLASH_MODEL_ID);
        expect(records[0]?.tag).toBe("match-bug");
        expect(records[0]?.inputTokens).toBe(1000);
        expect(records[0]?.outputTokens).toBe(500);
    });

    it("supports multiple roles in a single run, metered into one collector", async () => {
        const session = openModelSession();

        const matcher = session.getModel({ model: "smart-visual", tag: "match-bug" });
        const reviewer = session.getModel({ model: "smart-visual", tag: "review-generation" });

        await matcher.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "a" }] }] });
        await reviewer.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "b" }] }] });

        expect(session.costCollector.getRecords().map((r) => r.tag)).toEqual(["match-bug", "review-generation"]);
    });
});
