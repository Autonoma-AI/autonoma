import type { ModelMessage } from "ai";
import type { CompactionResult, MessageCompactor } from "../types";

const REDACTED_PLACEHOLDER = (toolName: string): string =>
    `<redacted: tool result for ${toolName} removed to fit the context window. Re-run the tool if this output is still needed.>`;

export class RedactOldToolResults implements MessageCompactor {
    readonly name: string;

    constructor(private readonly keepRecent: number) {
        if (keepRecent < 0) throw new Error("keepRecent must be >= 0");
        this.name = `redact-old-tool-results(keep=${keepRecent})`;
    }

    async compact(messages: ModelMessage[]): Promise<CompactionResult> {
        const toolMessageIndices: number[] = [];
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (message != null && message.role === "tool") toolMessageIndices.push(i);
        }

        if (toolMessageIndices.length <= this.keepRecent) {
            return { messages, messagesAffected: 0 };
        }

        const cutoffArrayIndex = toolMessageIndices.length - this.keepRecent;
        const cutoffMessageIndex = toolMessageIndices[cutoffArrayIndex];
        if (cutoffMessageIndex == null) {
            return { messages, messagesAffected: 0 };
        }

        let affected = 0;
        const next: ModelMessage[] = messages.map((message, i) => {
            if (message.role !== "tool" || i >= cutoffMessageIndex) return message;
            affected++;
            return {
                ...message,
                content: message.content.map((part) => {
                    if (part.type !== "tool-result") return part;
                    return {
                        ...part,
                        output: { type: "text" as const, value: REDACTED_PLACEHOLDER(part.toolName) },
                    };
                }),
            };
        });

        return { messages: next, messagesAffected: affected };
    }
}
