import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentLoop } from "../src/agent/agent-loop";
import { AgentTool } from "../src/agent/tools/agent-tool";
import { FatalToolError, FixableToolError } from "../src/agent/tools/tool-errors";

class TestTool extends AgentTool<{ value: number }, { doubled: number }> {
    constructor(
        private readonly behavior: "ok" | "fixable" | "fixable-with-suggestion" | "fatal" | "unknown",
        errorHandling?: "continue_unless_fatal" | "stop_unless_fixable",
    ) {
        const params: ConstructorParameters<typeof AgentTool>[0] = {
            name: "test_tool",
            description: "test",
            inputSchema: z.object({ value: z.number() }),
        };
        if (errorHandling != null) params.errorHandling = errorHandling;
        super(params);
    }

    protected async execute({ value }: { value: number }): Promise<{ doubled: number }> {
        switch (this.behavior) {
            case "ok":
                return { doubled: value * 2 };
            case "fixable":
                throw new FixableToolError("bad input");
            case "fixable-with-suggestion": {
                class SuggestingError extends FixableToolError {
                    suggestFix() {
                        return "try value=42";
                    }
                }
                throw new SuggestingError("bad input");
            }
            case "fatal":
                throw new FatalToolError("infra exploded");
            case "unknown":
                throw new Error("unclassified");
        }
    }
}

interface ExecutableTool {
    execute: (input: unknown, options: { toolCallId: string; messages: unknown[] }) => Promise<unknown>;
}

async function callTool(toolInstance: AgentTool<unknown, unknown>, input: unknown): Promise<unknown> {
    const loop = new AgentLoop({
        name: "test",
        // these fields are not exercised when we only call execute()
        model: undefined as never,
        systemPrompt: "",
        tools: [],
        reportTool: undefined as never,
    });
    const wrapped = toolInstance.toTool(loop) as unknown as ExecutableTool;
    return await wrapped.execute(input, { toolCallId: "tc1", messages: [] });
}

describe("AgentTool", () => {
    it("wraps a successful result in { success: true, result }", async () => {
        const result = await callTool(new TestTool("ok"), { value: 3 });
        expect(result).toEqual({ success: true, result: { doubled: 6 } });
    });

    it("converts a FixableToolError into a fixable failure envelope", async () => {
        const result = await callTool(new TestTool("fixable"), { value: 3 });
        expect(result).toEqual({ success: false, error: "bad input", fixSuggestion: undefined });
    });

    it("forwards suggestFix() output as fixSuggestion", async () => {
        const result = await callTool(new TestTool("fixable-with-suggestion"), { value: 3 });
        expect(result).toEqual({ success: false, error: "bad input", fixSuggestion: "try value=42" });
    });

    it("rethrows FatalToolError so the loop can terminate", async () => {
        await expect(callTool(new TestTool("fatal"), { value: 3 })).rejects.toThrow("infra exploded");
    });

    it("treats unclassified errors as fixable under the default policy", async () => {
        const result = await callTool(new TestTool("unknown"), { value: 3 });
        expect(result).toEqual({ success: false, error: "unclassified", fixSuggestion: undefined });
    });

    it("rethrows unclassified errors under stop_unless_fixable", async () => {
        await expect(callTool(new TestTool("unknown", "stop_unless_fixable"), { value: 3 })).rejects.toThrow(
            "unclassified",
        );
    });
});
