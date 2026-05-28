import type { AgentLoop, AgentTool } from "@autonoma/ai";

interface ExecutableTool {
    execute: (input: unknown, options: { toolCallId: string; messages: unknown[] }) => Promise<unknown>;
}

/**
 * Test helper: run an {@link AgentTool} against a concrete loop instance and
 * return whatever its AI-SDK wrapper produces. Mirrors the pattern used by
 * `packages/ai/tests/agent-tool.test.ts`.
 */
export async function executeTool<TOutput>(
    tool: AgentTool<unknown, unknown, AgentLoop>,
    input: unknown,
    loop: AgentLoop,
): Promise<TOutput> {
    const wrapped = tool.toTool(loop) as unknown as ExecutableTool;
    const result = await wrapped.execute(input, { toolCallId: "test", messages: [] });
    return result as TOutput;
}

/** Envelope type the AgentTool wrapper emits. Re-exported here for test ergonomics. */
export type ToolEnvelope<TOutput> =
    | { success: true; result: TOutput }
    | { success: false; error: string; fixSuggestion?: string };
