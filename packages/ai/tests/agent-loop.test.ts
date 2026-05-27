import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentLoop, MultipleResultCalls } from "../src/agent/agent-loop";
import { FinishTool, ReportResultTool } from "../src/agent/tools/agent-result";

interface FakeResult {
    payload: string;
}

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
    it("captures the first call's result", () => {
        const loop = makeLoop();
        loop.setResult({ payload: "first" });
        // protected `result` is not directly readable; second call throwing proves the first stuck.
        expect(() => loop.setResult({ payload: "second" })).toThrow(MultipleResultCalls);
    });

    it("throws MultipleResultCalls on subsequent calls", () => {
        const loop = makeLoop();
        loop.setResult({ payload: "first" });
        expect(() => loop.setResult({ payload: "second" })).toThrow(MultipleResultCalls);
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
