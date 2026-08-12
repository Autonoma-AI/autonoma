import { Screenshot } from "@autonoma/image";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { CommandSpec } from "../../commands";
import type { BaseCommandContext } from "../../platform";
import { ExecutionAgent } from "./execution-agent";
import type { CommandTool } from "./tools/command-tool";

// A 1x1 transparent PNG. The bytes never get decoded in these tests - the agent only embeds the
// base64 as an image content part - but a real image keeps the fixture honest.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const FAKE_USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

/** A driver context whose screenshot/stability calls are inert - enough to drive the agent loop. */
function fakeContext(): BaseCommandContext {
    return {
        screen: {
            getResolution: async () => ({ width: 1, height: 1 }),
            screenshot: async () => Screenshot.fromBase64(PNG_BASE64),
        },
        application: {
            waitUntilStable: async () => undefined,
        },
    };
}

/**
 * A model that calls `wait` on the first `waitSteps` steps, then `execution-finished`. Each step's
 * prompt is captured via {@link MockLanguageModelV4.doGenerateCalls}, so a test can inspect exactly
 * what the loop handed the model on any step.
 */
function scriptedModel(waitSteps: number): MockLanguageModelV4 {
    let step = 0;
    return new MockLanguageModelV4({
        doGenerate: async () => {
            step += 1;
            const finishing = step > waitSteps;
            const toolCall = finishing
                ? {
                      type: "tool-call" as const,
                      toolCallId: `finish-${step}`,
                      toolName: "execution-finished",
                      input: JSON.stringify({ success: true, reasoning: "done" }),
                  }
                : {
                      type: "tool-call" as const,
                      toolCallId: `wait-${step}`,
                      toolName: "wait",
                      input: JSON.stringify({ seconds: 0 }),
                  };
            return {
                content: [toolCall],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: FAKE_USAGE,
                warnings: [],
            };
        },
    });
}

function makeAgent(model: MockLanguageModelV4): ExecutionAgent<CommandSpec, BaseCommandContext> {
    const noCommandTools: CommandTool<CommandSpec, BaseCommandContext>[] = [];
    return new ExecutionAgent<CommandSpec, BaseCommandContext>({
        model,
        systemPrompt: "system",
        maxSteps: 10,
        commandTools: noCommandTools,
        minTimeBetweenSteps: 0,
        maxTimeBetweenSteps: 0,
        drivers: fakeContext(),
        onFinish: async () => undefined,
        beforeCommand: async () => undefined,
        onAttempt: async () => undefined,
        beforeMetadata: async () => ({}),
        afterMetadata: async () => ({}),
    });
}

type CapturedPrompt = MockLanguageModelV4["doGenerateCalls"][number]["prompt"];

/** Counts the image/view parts across every message in a captured model prompt. */
function countViewParts(prompt: CapturedPrompt): number {
    let count = 0;
    for (const message of prompt) {
        if (typeof message.content === "string") continue;
        for (const part of message.content) {
            if (part.type === "file") count += 1;
        }
    }
    return count;
}

/**
 * Collapse a captured prompt into one token per message, capturing what actually matters for these
 * tests: the role, whether a message carries a screenshot, and which tool a turn calls or answers.
 */
function outline(prompt: CapturedPrompt): string[] {
    return prompt.map((message) => {
        if (typeof message.content === "string") return `${message.role}:text`;
        for (const part of message.content) {
            if (part.type === "file") return `${message.role}:view`;
            if (part.type === "tool-call") return `${message.role}:call(${part.toolName})`;
            if (part.type === "tool-result") return `${message.role}:result(${part.toolName})`;
        }
        return `${message.role}:text`;
    });
}

describe("ExecutionAgent per-step context injection", () => {
    it("keeps exactly one screenshot in the prompt on every step, not one per step so far", async () => {
        const model = scriptedModel(3);

        await makeAgent(model).generate("do the thing");

        // Four model calls: three `wait` steps plus the finishing step.
        expect(model.doGenerateCalls.length).toBe(4);
        for (const [index, call] of model.doGenerateCalls.entries()) {
            expect(countViewParts(call.prompt), `step ${index + 1} should carry a single screenshot`).toBe(1);
        }
    });

    it("hands the model its full real conversation plus one current screenshot, not a re-injected stack", async () => {
        const model = scriptedModel(3);

        await makeAgent(model).generate("do the thing");

        // The finishing step must see: the system prompt, the original instruction, every prior
        // wait turn (call + result) in order, and exactly one trailing screenshot - never the
        // earlier steps' screenshots. Anything else means the per-step override leaked forward or
        // the reconstructed base dropped a real turn.
        const finalPrompt = model.doGenerateCalls.at(-1)?.prompt ?? [];
        expect(outline(finalPrompt)).toEqual([
            "system:text",
            "user:text",
            "assistant:call(wait)",
            "tool:result(wait)",
            "assistant:call(wait)",
            "tool:result(wait)",
            "assistant:call(wait)",
            "tool:result(wait)",
            "user:view",
        ]);
    });
});
