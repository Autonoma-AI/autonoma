import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentLoop } from "../src/agent/agent-loop";
import { FinishTool } from "../src/agent/tools/agent-result";
import { AgentTool, type AgentToolModelOutputOptions } from "../src/agent/tools/agent-tool";
import { imageToolContent } from "../src/agent/tools/image-tool-content";
import { noopLogger, setDefaultLogger } from "../src/logger";

const FAKE_USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const FRAME_BASE64 = "aGVsbG8=";
const FRAME_MEDIA_TYPE = "image/jpeg";

afterEach(() => setDefaultLogger(noopLogger));

class FrameTool extends AgentTool<Record<string, never>, { base64: string; mediaType: string }> {
    constructor() {
        super({ name: "view_frame", description: "returns a frame", inputSchema: z.object({}) });
    }

    protected async execute() {
        return { base64: FRAME_BASE64, mediaType: FRAME_MEDIA_TYPE };
    }

    protected override toModelOutput({
        output,
    }: AgentToolModelOutputOptions<Record<string, never>, { base64: string; mediaType: string }>) {
        if (!output.success) return { type: "error-text" as const, value: output.error };
        return { type: "content" as const, value: [imageToolContent(output.result)] };
    }
}

/** Calls `view_frame` on the first step, then finishes - so step two's prompt carries the frame. */
function callsFrameThenFinishes(): MockLanguageModelV3 {
    let step = 0;
    return new MockLanguageModelV3({
        doGenerate: async () => {
            step += 1;
            const call =
                step === 1
                    ? { toolCallId: "frame-1", toolName: "view_frame", input: "{}" }
                    : { toolCallId: "finish-1", toolName: "finish", input: JSON.stringify({ payload: "done" }) };
            return {
                content: [{ type: "tool-call" as const, ...call }],
                finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
                usage: FAKE_USAGE,
                warnings: [],
            };
        },
    });
}

describe("imageToolContent", () => {
    it("reaches the model as a file part carrying the frame's own media type", async () => {
        // Asserts on the CONVERTED prompt: a stale content-part spelling is not a crash, so the drop only
        // shows up at the model boundary.
        const model = callsFrameThenFinishes();
        setDefaultLogger(noopLogger);

        await new AgentLoop<{ payload: string }>({
            name: "frame-loop",
            model,
            systemPrompt: "system",
            tools: [new FrameTool()],
            reportTool: new FinishTool({ resultSchema: z.object({ payload: z.string() }) }),
        }).runLoop([{ role: "user", content: "go" }]);

        const secondCall = model.doGenerateCalls[1];
        const toolMessage = secondCall?.prompt.find((message) => message.role === "tool");
        const toolResult = toolMessage?.content.find((part) => part.type === "tool-result");
        expect(toolResult?.output).toEqual({
            type: "content",
            value: [{ type: "file", data: { type: "data", data: FRAME_BASE64 }, mediaType: FRAME_MEDIA_TYPE }],
        });
    });
});
