import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
    AgentGenerationFailed,
    AgentLoop,
    AgentLoopError,
    MaxStepsReached,
    MultipleResultCalls,
    ToolCallFailedFatally,
} from "../src/agent/agent-loop";
import { FinishTool, ReportResultTool } from "../src/agent/tools/agent-result";
import { AgentTool, type AgentToolModelOutputOptions } from "../src/agent/tools/agent-tool";
import { imageToolContent } from "../src/agent/tools/image-tool-content";
import { FatalToolError } from "../src/agent/tools/tool-errors";
import { type Logger, noopLogger, setDefaultLogger } from "../src/logger";

interface FakeResult {
    payload: string;
}

interface LogRecord {
    bindings: Record<string, unknown>;
    level: "info" | "warn" | "error" | "fatal";
    message: string;
    extra?: Record<string, unknown>;
}

/** A {@link Logger} that records every emitted line (with its accumulated child bindings). */
class RecordingLogger implements Logger {
    constructor(
        readonly sink: LogRecord[] = [],
        private readonly bindings: Record<string, unknown> = {},
    ) {}
    child(bindings: Record<string, unknown>): Logger {
        return new RecordingLogger(this.sink, { ...this.bindings, ...bindings });
    }
    private record(level: LogRecord["level"], message: string, extra?: Record<string, unknown>): void {
        this.sink.push({ bindings: this.bindings, level, message, extra });
    }
    info(message: string, extra?: Record<string, unknown>): void {
        this.record("info", message, extra);
    }
    warn(message: string, extra?: Record<string, unknown>): void {
        this.record("warn", message, extra);
    }
    error(message: string): void {
        this.record("error", message);
    }
    fatal(message: string): void {
        this.record("fatal", message);
    }
}

afterEach(() => setDefaultLogger(noopLogger));

function makeLoop(): AgentLoop<FakeResult> {
    return new AgentLoop<FakeResult>({
        name: "test-loop",
        model: undefined as never,
        systemPrompt: "",
        tools: [],
        reportTool: undefined as never,
    });
}

describe("AgentLoop.setResult", () => {
    it("throws MultipleResultCalls on subsequent calls", () => {
        const loop = makeLoop();
        loop.setResult({ payload: "first" });
        expect(() => loop.setResult({ payload: "second" })).toThrow(MultipleResultCalls);
    });

    it("treats a null result as produced, for an agent whose result type admits null", () => {
        const loop = new AgentLoop<FakeResult | null>({
            name: "nullable-loop",
            model: undefined as never,
            systemPrompt: "",
            tools: [],
            reportTool: undefined as never,
        });
        loop.setResult(null);

        expect(() => loop.setResult({ payload: "second" })).toThrow(MultipleResultCalls);
    });

    it("logs both the kept and the discarded payload at warn", () => {
        const sink: LogRecord[] = [];
        setDefaultLogger(new RecordingLogger(sink));
        const loop = makeLoop();
        loop.setResult({ payload: "first" });

        expect(() => loop.setResult({ payload: "second" })).toThrow(MultipleResultCalls);

        const warning = sink.find((r) => r.level === "warn");
        expect(warning?.extra).toEqual({ keptResult: { payload: "first" }, discardedResult: { payload: "second" } });
    });
});

const FAKE_USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

/** A tool that does nothing but keeps the loop going - it never reports a result. */
class NoopTool extends AgentTool<{ note: string }, { ok: true }> {
    constructor() {
        super({ name: "noop", description: "Does nothing.", inputSchema: z.object({ note: z.string() }) });
    }
    protected async execute(): Promise<{ ok: true }> {
        return { ok: true };
    }
}

/** A model that calls `noop` on every step and never finishes - exercises the step-cap backstop. */
function alwaysCallsNoopModel(): MockLanguageModelV3 {
    let step = 0;
    return new MockLanguageModelV3({
        doGenerate: async () => {
            step += 1;
            return {
                content: [
                    {
                        type: "tool-call",
                        toolCallId: `noop-${step}`,
                        toolName: "noop",
                        input: JSON.stringify({ note: `step ${step}` }),
                    },
                ],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: FAKE_USAGE,
                warnings: [],
            };
        },
    });
}

function makeBoundedLoop(model: MockLanguageModelV3, maxSteps?: number): AgentLoop<FakeResult> {
    return new AgentLoop<FakeResult>({
        name: "bounded-loop",
        model,
        systemPrompt: "system",
        tools: [new NoopTool()],
        reportTool: new FinishTool({ resultSchema: z.object({ payload: z.string() }) }),
        maxSteps,
    });
}

describe("AgentLoop forces tool calls and stays bounded", () => {
    it("forces toolChoice 'required' on every model call", async () => {
        const model = alwaysCallsNoopModel();
        await makeBoundedLoop(model, 3)
            .runLoop([{ role: "user", content: "go" }])
            .catch(() => undefined);

        expect(model.doGenerateCalls.length).toBe(3);
        for (const call of model.doGenerateCalls) {
            expect(call.toolChoice).toEqual({ type: "required" });
        }
    });

    it("routes tool logs through the logger registered with setDefaultLogger", async () => {
        const sink: LogRecord[] = [];
        setDefaultLogger(new RecordingLogger(sink));

        await new AgentLoop<FakeResult>({
            name: "logged-loop",
            model: alwaysCallsNoopModel(),
            systemPrompt: "system",
            tools: [new NoopTool()],
            reportTool: new FinishTool({ resultSchema: z.object({ payload: z.string() }) }),
            maxSteps: 2,
        })
            .runLoop([{ role: "user", content: "go" }])
            .catch(() => undefined);

        // Tools must log through the registered default logger, not the silent built-in default.
        const toolLogs = sink.filter((r) => r.bindings.toolName === "noop");
        expect(toolLogs.length).toBeGreaterThan(0);
    });

    it("stops with MaxStepsReached when the model never reports a result", async () => {
        const model = alwaysCallsNoopModel();
        await expect(makeBoundedLoop(model, 4).runLoop([{ role: "user", content: "go" }])).rejects.toThrow(
            MaxStepsReached,
        );
        expect(model.doGenerateCalls.length).toBe(4);
    });

    it("returns the result and stops once the report tool fires", async () => {
        const model = new MockLanguageModelV3({
            doGenerate: async () => ({
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "finish-1",
                        toolName: "finish",
                        input: JSON.stringify({ payload: "done" }),
                    },
                ],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: FAKE_USAGE,
                warnings: [],
            }),
        });
        const loop = new AgentLoop<FakeResult>({
            name: "finishing-loop",
            model,
            systemPrompt: "system",
            tools: [],
            reportTool: new FinishTool({ resultSchema: z.object({ payload: z.string() }) }),
        });

        const { result } = await loop.runLoop([{ role: "user", content: "go" }]);

        expect(result).toEqual({ payload: "done" });
        expect(model.doGenerateCalls.length).toBe(1);
        expect(model.doGenerateCalls[0]?.toolChoice).toEqual({ type: "required" });
    });

    it("keeps the first result when the model reports twice in one step, instead of killing the run", async () => {
        const model = new MockLanguageModelV3({
            doGenerate: async () => ({
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "finish-1",
                        toolName: "finish",
                        input: JSON.stringify({ payload: "first" }),
                    },
                    {
                        type: "tool-call",
                        toolCallId: "finish-2",
                        toolName: "finish",
                        input: JSON.stringify({ payload: "second" }),
                    },
                ],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: FAKE_USAGE,
                warnings: [],
            }),
        });
        const loop = new AgentLoop<FakeResult>({
            name: "stuttering-loop",
            model,
            systemPrompt: "system",
            tools: [],
            reportTool: new FinishTool({ resultSchema: z.object({ payload: z.string() }) }),
            maxSteps: 5,
        });

        const { result } = await loop.runLoop([{ role: "user", content: "go" }]);

        expect(result).toEqual({ payload: "first" });
        expect(model.doGenerateCalls.length).toBe(1);
    });
});

/** A model that drives `noop` for `workingSteps` steps, then fails the way a dead provider connection would. */
function failsAfterModel(workingSteps: number, failure: string): MockLanguageModelV3 {
    let step = 0;
    return new MockLanguageModelV3({
        doGenerate: async () => {
            step += 1;
            if (step > workingSteps) throw new Error(failure);
            return {
                content: [
                    {
                        type: "tool-call",
                        toolCallId: `noop-${step}`,
                        toolName: "noop",
                        input: JSON.stringify({ note: `step ${step}` }),
                    },
                ],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: FAKE_USAGE,
                warnings: [],
            };
        },
    });
}

async function failureOf(loop: AgentLoop<FakeResult>): Promise<AgentLoopError> {
    try {
        await loop.runLoop([{ role: "user", content: "go" }]);
    } catch (error) {
        if (error instanceof AgentLoopError) return error;
        throw error;
    }
    throw new Error("expected the loop to fail");
}

describe("a failed run still carries its transcript", () => {
    it("wraps a model-call failure in AgentGenerationFailed carrying the steps completed so far", async () => {
        const failure = await failureOf(makeBoundedLoop(failsAfterModel(2, "socket hang up")));

        expect(failure).toBeInstanceOf(AgentGenerationFailed);
        // Two steps ran, so the transcript holds their assistant turns and tool results.
        expect(failure.conversation.length).toBeGreaterThan(0);
        expect(JSON.stringify(failure.conversation)).toContain("noop-2");
    });

    it("keeps the provider's reason in the message, where string-based categorization reads it", async () => {
        const failure = await failureOf(makeBoundedLoop(failsAfterModel(1, "socket hang up")));

        expect(failure.message).toContain("socket hang up");
        expect((failure as AgentGenerationFailed).cause).toBeInstanceOf(Error);
    });

    it("reports an empty transcript when the very first call fails, rather than throwing", async () => {
        const failure = await failureOf(makeBoundedLoop(failsAfterModel(0, "429 rate limited")));

        expect(failure).toBeInstanceOf(AgentGenerationFailed);
        expect(failure.conversation).toEqual([]);
        expect(failure.message).toContain("429 rate limited");
    });

    it("still carries the transcript when the run exhausts its step budget", async () => {
        const failure = await failureOf(makeBoundedLoop(alwaysCallsNoopModel(), 3));

        expect(failure).toBeInstanceOf(MaxStepsReached);
        expect(JSON.stringify(failure.conversation)).toContain("noop-3");
    });
});

/** A loop that shapes its persisted transcript, the way an agent with non-reproducible prompt context does. */
class PrefixingLoop extends AgentLoop<FakeResult> {
    protected override buildTranscript(userPrompt: ModelMessage[], modelMessages: ModelMessage[]): ModelMessage[] {
        return [{ role: "user", content: `prompt:${userPrompt.length}` }, ...modelMessages];
    }
}

describe("buildTranscript shapes both outcomes", () => {
    function prefixingLoop(model: MockLanguageModelV3, maxSteps?: number): PrefixingLoop {
        return new PrefixingLoop({
            name: "prefixing-loop",
            model,
            systemPrompt: "system",
            tools: [new NoopTool()],
            reportTool: new FinishTool({ resultSchema: z.object({ payload: z.string() }) }),
            maxSteps,
        });
    }

    it("applies the override on the failure path, not just the success path", async () => {
        const failure = await failureOf(prefixingLoop(failsAfterModel(1, "socket hang up")));

        // A subclass wrapping `runLoop` could only shape the value it RETURNS, which would drop its prompt
        // context from every failed run - hence the hook rather than a wrapper.
        expect(failure.conversation[0]).toEqual({ role: "user", content: "prompt:1" });
    });

    it("applies the override on the success path too", async () => {
        const model = new MockLanguageModelV3({
            doGenerate: async () => ({
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "finish-1",
                        toolName: "finish",
                        input: JSON.stringify({ payload: "done" }),
                    },
                ],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: FAKE_USAGE,
                warnings: [],
            }),
        });

        const { conversation } = await prefixingLoop(model).runLoop([{ role: "user", content: "go" }]);

        expect(conversation[0]).toEqual({ role: "user", content: "prompt:1" });
        expect(conversation.length).toBeGreaterThan(1);
    });
});

/** A frame-viewing tool: hands the model inline image bytes, the way the screenshot tools do. */
class ScreenshotTool extends AgentTool<{ note: string }, { base64: string; mediaType: string }> {
    constructor() {
        super({ name: "noop", description: "Views a frame.", inputSchema: z.object({ note: z.string() }) });
    }
    protected async execute(): Promise<{ base64: string; mediaType: string }> {
        return { base64: "AAAABBBBCCCC", mediaType: "image/png" };
    }
    protected override toModelOutput({
        output,
    }: AgentToolModelOutputOptions<{ note: string }, { base64: string; mediaType: string }>) {
        if (!output.success) return { type: "error-json" as const, value: { error: output.error } };
        return { type: "content" as const, value: [imageToolContent(output.result)] };
    }
}

describe("a transcript never carries inline media", () => {
    // Screenshots reach a transcript through tool RESULTS, and transcripts get JSON-serialized into storage.
    // A run inspecting a dozen frames would otherwise write megabytes of base64 per record.
    function screenshotLoop(model: MockLanguageModelV3): AgentLoop<FakeResult> {
        return new AgentLoop<FakeResult>({
            name: "screenshot-loop",
            model,
            systemPrompt: "system",
            tools: [new ScreenshotTool()],
            reportTool: new FinishTool({ resultSchema: z.object({ payload: z.string() }) }),
            maxSteps: 5,
        });
    }

    it("replaces tool-result media with a placeholder on the success path", async () => {
        const { conversation } = await screenshotLoop(callsThenFinishesModel()).runLoop([
            { role: "user", content: "go" },
        ]);

        const serialized = JSON.stringify(conversation);
        expect(serialized).not.toContain("AAAABBBBCCCC");
        expect(serialized).toContain("media omitted");
    });

    it("replaces it on the failure path too", async () => {
        // Same tool, but the model call dies after the frame was viewed.
        let step = 0;
        const model = new MockLanguageModelV3({
            doGenerate: async () => {
                step += 1;
                if (step > 1) throw new Error("socket hang up");
                return {
                    content: [
                        {
                            type: "tool-call" as const,
                            toolCallId: "noop-1",
                            toolName: "noop",
                            input: JSON.stringify({ note: "x" }),
                        },
                    ],
                    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
                    usage: FAKE_USAGE,
                    warnings: [],
                };
            },
        });

        const failure = await failureOf(screenshotLoop(model));

        const serialized = JSON.stringify(failure.conversation);
        expect(serialized).not.toContain("AAAABBBBCCCC");
        expect(serialized).toContain("media omitted");
    });
});

/** A tool that always throws the "unrecoverable" error class. */
class FatalTool extends AgentTool<{ note: string }, never> {
    constructor() {
        super({ name: "noop", description: "Always fails.", inputSchema: z.object({ note: z.string() }) });
    }
    protected async execute(): Promise<never> {
        throw new FatalToolError("this tool is broken");
    }
}

/** Calls `noop` on the first step, then reports a result - so a loop that ignored the failure would finish. */
function callsThenFinishesModel(): MockLanguageModelV3 {
    let step = 0;
    return new MockLanguageModelV3({
        doGenerate: async () => {
            step += 1;
            const call =
                step === 1
                    ? { toolCallId: "noop-1", toolName: "noop", input: JSON.stringify({ note: "x" }) }
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

describe("logs never carry inline media", () => {
    const FRAME = "A".repeat(200_000);

    class BigFrameTool extends AgentTool<{ note: string }, { stepOrder: number; base64: string }> {
        constructor() {
            super({ name: "noop", description: "Views a frame.", inputSchema: z.object({ note: z.string() }) });
        }
        protected async execute(): Promise<{ stepOrder: number; base64: string }> {
            return { stepOrder: 3, base64: FRAME };
        }
    }

    it("elides an oversized tool result, keeping the rest of it readable", async () => {
        const sink: LogRecord[] = [];
        setDefaultLogger(new RecordingLogger(sink));

        await new AgentLoop<FakeResult>({
            name: "frame-loop",
            model: callsThenFinishesModel(),
            systemPrompt: "system",
            tools: [new BigFrameTool()],
            reportTool: new FinishTool({ resultSchema: z.object({ payload: z.string() }) }),
            maxSteps: 5,
        }).runLoop([{ role: "user", content: "go" }]);

        const serialized = JSON.stringify(sink);
        expect(serialized).not.toContain(FRAME);
        expect(serialized).toContain("200000 chars elided");

        const toolLog = sink.find((r) => r.message === "Tool executed successfully");
        expect(toolLog?.extra?.result).toEqual({ stepOrder: 3, base64: "[200000 chars elided]" });
    });
});

describe("a tool's FatalToolError ends the run", () => {
    // The AI SDK swallows anything a tool throws into a `tool-error` part and carries on, so the throw alone
    // never reaches the loop; only the tool wrapper reporting it at the throw site stops the run.
    function fatalToolLoop(model: MockLanguageModelV3): AgentLoop<FakeResult> {
        return new AgentLoop<FakeResult>({
            name: "fatal-tool-loop",
            model,
            systemPrompt: "system",
            tools: [new FatalTool()],
            reportTool: new FinishTool({ resultSchema: z.object({ payload: z.string() }) }),
            maxSteps: 5,
        });
    }

    it("stops the loop and surfaces the tool and its cause to the caller", async () => {
        const model = callsThenFinishesModel();

        const failure = await failureOf(fatalToolLoop(model));

        expect(failure).toBeInstanceOf(ToolCallFailedFatally);
        expect((failure as ToolCallFailedFatally).toolName).toBe("noop");
        expect(failure.message).toContain("this tool is broken");
        expect((failure as ToolCallFailedFatally).cause).toBeInstanceOf(FatalToolError);
        // The model never got a second turn: the run ended at the step the tool failed in.
        expect(model.doGenerateCalls.length).toBe(1);
    });

    it("carries the transcript, like every other loop failure", async () => {
        const failure = await failureOf(fatalToolLoop(callsThenFinishesModel()));

        expect(failure.conversation.length).toBeGreaterThan(0);
        expect(JSON.stringify(failure.conversation)).toContain("noop-1");
    });

    it("wins over a result reported in the same step", async () => {
        // A tool that declared itself broken compromises the run, so a verdict the model still managed to
        // report is not one to trust.
        const model = new MockLanguageModelV3({
            doGenerate: async () => ({
                content: [
                    { type: "tool-call", toolCallId: "noop-1", toolName: "noop", input: JSON.stringify({ note: "x" }) },
                    {
                        type: "tool-call",
                        toolCallId: "finish-1",
                        toolName: "finish",
                        input: JSON.stringify({ payload: "done" }),
                    },
                ],
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: FAKE_USAGE,
                warnings: [],
            }),
        });

        await expect(fatalToolLoop(model).runLoop([{ role: "user", content: "go" }])).rejects.toThrow(
            ToolCallFailedFatally,
        );
    });
});

describe("ReportResultTool", () => {
    it("sets the loop result via buildResult and returns { finished: true }", async () => {
        const finish = new FinishTool({ resultSchema: z.object({ payload: z.string() }) });
        const loop = makeLoop();

        interface ExecutableTool {
            execute: (input: unknown, opts: { toolCallId: string; messages: unknown[] }) => Promise<unknown>;
        }
        const wrapped = finish.toTool(loop) as unknown as ExecutableTool;
        const wrapperResult = await wrapped.execute({ payload: "hi" }, { toolCallId: "1", messages: [] });

        expect(wrapperResult).toEqual({ success: true, result: { finished: true } });
        expect(() => loop.setResult({ payload: "again" })).toThrow(MultipleResultCalls);
    });

    it("supports a custom ReportResultTool that derives the result from the loop", async () => {
        class CollectorLoop extends AgentLoop<{ payload: string; count: number }> {
            public actions: string[] = [];
        }

        class CustomReport extends ReportResultTool<
            { payload: string },
            { payload: string; count: number },
            CollectorLoop
        > {
            constructor() {
                super({
                    name: "finish",
                    description: "finish",
                    inputSchema: z.object({ payload: z.string() }),
                });
            }
            async buildResult(input: { payload: string }, loop: CollectorLoop) {
                return { payload: input.payload, count: loop.actions.length };
            }
        }

        const loop = new CollectorLoop({
            name: "collector-loop",
            model: undefined as never,
            systemPrompt: "",
            tools: [],
            reportTool: undefined as never,
        });
        loop.actions.push("a", "b", "c");

        const reportTool = new CustomReport();
        interface ExecutableTool {
            execute: (input: unknown, opts: { toolCallId: string; messages: unknown[] }) => Promise<unknown>;
        }
        const wrapped = reportTool.toTool(loop) as unknown as ExecutableTool;
        await wrapped.execute({ payload: "ok" }, { toolCallId: "1", messages: [] });

        // setResult should now hold what buildResult returned. We verify indirectly: a second
        // setResult throws.
        expect(() => loop.setResult({ payload: "again", count: 0 })).toThrow(MultipleResultCalls);
    });
});
