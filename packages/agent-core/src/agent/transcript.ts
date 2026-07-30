import type { ModelMessage, ToolResultPart } from "ai";

/** Stands in for elided binary content, so a reader can tell something was there rather than missing. */
const MEDIA_PLACEHOLDER = "[media omitted from the transcript]";

/**
 * Remove binary content from a transcript, leaving a placeholder in its place.
 *
 * Transcripts get JSON-serialized and stored, and a single screenshot is a multi-megabyte base64 string - a run
 * that inspects a dozen frames would write a transcript orders of magnitude larger than the reasoning anyone
 * wants to read out of it. Images reach a transcript through tool RESULTS (a frame-viewing tool hands the model
 * inline media) as well as through prompts, so both paths are covered.
 *
 * The loop applies this after {@link AgentLoop.buildTranscript}, so no subclass can reintroduce media. Media
 * worth keeping is referenced by a storage key on the record, never inlined here.
 */
export function stripMedia(messages: ModelMessage[]): ModelMessage[] {
    return messages.map(stripMessage);
}

function stripMessage(message: ModelMessage): ModelMessage {
    if (typeof message.content === "string") return message;

    if (message.role === "tool") {
        // A tool message also carries approval responses, which hold no media - pass those straight through.
        return {
            ...message,
            content: message.content.map((part) => (part.type === "tool-result" ? stripToolResult(part) : part)),
        };
    }

    if (message.role === "user") {
        return {
            ...message,
            content: message.content.map((part) =>
                part.type === "image" || part.type === "file" ? { type: "text", text: MEDIA_PLACEHOLDER } : part,
            ),
        };
    }

    if (message.role === "assistant") {
        return {
            ...message,
            content: message.content.map((part) => {
                if (part.type === "file") return { type: "text", text: MEDIA_PLACEHOLDER };
                return part.type === "tool-result" ? stripToolResult(part) : part;
            }),
        };
    }

    return message;
}

/** Only a `content` output can hold media (via `toModelOutput`); every other output type is text or JSON. */
function stripToolResult(part: ToolResultPart): ToolResultPart {
    if (part.output.type !== "content") return part;
    return {
        ...part,
        output: {
            type: "content",
            value: part.output.value.map((item) =>
                item.type === "media" ? { type: "text", text: MEDIA_PLACEHOLDER } : item,
            ),
        },
    };
}
