import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentLoop, MaxStepsReached, MultipleResultCalls } from "../src/agent/agent-loop";
import { FinishTool, ReportResultTool } from "../src/agent/tools/agent-result";
import { AgentTool } from "../src/agent/tools/agent-tool";
import { type Logger, noopLogger, setDefaultLogger } from "../src/logger";

interface FakeResult {
    payload: string;
}

interface LogRecord {
    bindings: Record<string, unknown>;
    message: string;
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
    private record(message: string): void {
        this.sink.push({ bindings: this.bindings, message });
    }
    info(message: string): void {
        this.record(message);
    }
    warn(message: string): void {
        this.record(message);
    }
    error(message: string): void {
        this.record(message);
    }
    fatal(message: string): void {
        this.record(message);
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
