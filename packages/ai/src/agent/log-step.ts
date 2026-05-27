import type { Logger } from "@autonoma/logger";
import type { ContentPart, ToolSet } from "ai";

/**
 * Default per-step logger used by {@link AgentLoop.onStepFinish}. Pulls the text, tool calls,
 * tool results, and tool errors out of the step content into a single structured log line.
 */
export function logStepContent(logger: Logger, stepContent: ContentPart<ToolSet>[]) {
    logger.info("Agent step finished", {
        text: stepContent
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n"),
        toolCalls: stepContent
            .filter((c) => c.type === "tool-call")
            .map((c) => ({
                name: c.toolName,
                id: c.toolCallId,
                input: c.input,
            })),
        toolResults: stepContent
            .filter((c) => c.type === "tool-result")
            .map((c) => ({
                name: c.toolName,
                id: c.toolCallId,
                output: c.output,
            })),
        toolErrors: stepContent
            .filter((c) => c.type === "tool-error")
            .map((c) => ({
                name: c.toolName,
                id: c.toolCallId,
                error: c.error,
            })),
    });
}
