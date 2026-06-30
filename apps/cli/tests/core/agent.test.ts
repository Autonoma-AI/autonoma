import { APICallError, type ModelMessage } from "ai";
import type * as AiModule from "ai";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { runAgent, formatRetryGuidance, type AgentConfig } from "../../src/core/agent";

interface GenerateCall {
    messages: ModelMessage[];
}

const generateCalls: GenerateCall[] = [];
let generateImpl: () => Promise<{ response: { messages: ModelMessage[] } }>;

vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof AiModule>();
    class MockToolLoopAgent {
        async generate(args: { messages: ModelMessage[] }) {
            generateCalls.push({ messages: [...args.messages] });
            return generateImpl();
        }
    }
    return { ...actual, ToolLoopAgent: MockToolLoopAgent };
});

function apiError(statusCode: number): APICallError {
    return new APICallError({
        message: `HTTP ${statusCode}`,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode,
        responseHeaders: {},
        responseBody: "",
    });
}

function makeConfig(): AgentConfig {
    return {
        id: "test-agent",
        systemPrompt: "system",
        tools: {},
        // The mocked ToolLoopAgent never touches the model.
        model: {} as AgentConfig["model"],
        maxSteps: 10,
    };
}

const emptyGeneration = { response: { messages: [] as ModelMessage[] } };

beforeAll(() => {
    process.env.DONT_TRACK = "1";
    process.env.AUTONOMA_API_TOKEN ||= "test-token";
});

beforeEach(() => {
    generateCalls.length = 0;
    vi.useRealTimers();
});

describe("runAgent", () => {
    test("returns the result when the finish tool captured one", async () => {
        let result: string | undefined;
        generateImpl = async () => {
            result = "done";
            return emptyGeneration;
        };

        const value = await runAgent(makeConfig(), "do the task", () => result);

        expect(value).toBe("done");
        expect(generateCalls).toHaveLength(1);
    });

    test("nudges the agent when it stops without a result", async () => {
        let result: string | undefined;
        generateImpl = async () => {
            if (generateCalls.length >= 2) result = "done";
            return { response: { messages: [{ role: "assistant", content: "I think I'm done" }] } };
        };

        const value = await runAgent(makeConfig(), "do the task", () => result);

        expect(value).toBe("done");
        expect(generateCalls).toHaveLength(2);

        // The second call continues the conversation: original prompt, the
        // assistant's response, then the nudge.
        const second = generateCalls[1]!.messages;
        expect(second[0]).toEqual({ role: "user", content: "do the task" });
        expect(second[1]).toEqual({ role: "assistant", content: "I think I'm done" });
        const last = second.at(-1)!;
        expect(last.role).toBe("user");
        expect(String(last.content)).toContain("finish tool");
    });

    test("caps nudges and returns undefined when the agent never finishes", async () => {
        generateImpl = async () => emptyGeneration;

        const value = await runAgent(makeConfig(), "do the task", () => undefined);

        expect(value).toBeUndefined();
        // Initial attempt + 2 nudges.
        expect(generateCalls).toHaveLength(3);
    });

    test("retries transient provider errors", async () => {
        vi.useFakeTimers();
        let result: string | undefined;
        generateImpl = async () => {
            if (generateCalls.length === 1) throw apiError(429);
            result = "done";
            return emptyGeneration;
        };

        const promise = runAgent(makeConfig(), "do the task", () => result);
        await vi.runAllTimersAsync();

        expect(await promise).toBe("done");
        expect(generateCalls).toHaveLength(2);
    });

    test("throws immediately on fatal errors", async () => {
        generateImpl = async () => {
            throw apiError(401);
        };

        await expect(runAgent(makeConfig(), "do the task", () => undefined)).rejects.toThrow("HTTP 401");
        expect(generateCalls).toHaveLength(1);
    });
});

describe("formatRetryGuidance", () => {
    test("returns empty string without guidance", () => {
        expect(formatRetryGuidance()).toBe("");
        expect(formatRetryGuidance("   ")).toBe("");
    });

    test("wraps guidance in a retry block", () => {
        const block = formatRetryGuidance("the models live in db/schema");
        expect(block).toContain("previous attempt");
        expect(block).toContain('"the models live in db/schema"');
    });
});
