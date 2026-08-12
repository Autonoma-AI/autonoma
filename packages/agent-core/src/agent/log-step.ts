import type { ContentPart, ToolSet } from "ai";
import type { Logger } from "../logger";
import { redactForLog } from "./log-redaction";

/**
 * Default per-step logger used by {@link AgentLoop.onStepFinish}. Pulls the text, tool calls,
 * tool results, and tool errors out of the step content into a single structured log line.
 *
 * Results are named, not dumped - {@link AgentTool} logs each one as it returns.
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
                input: redactForLog(c.input),
            })),
        toolResults: stepContent
            .filter((c) => c.type === "tool-result")
            .map((c) => ({
                name: c.toolName,
                id: c.toolCallId,
            })),
        toolErrors: stepContent
            .filter((c) => c.type === "tool-error")
            .map((c) => ({
                name: c.toolName,
                id: c.toolCallId,
                error: redactForLog(c.error),
            })),
    });
}
