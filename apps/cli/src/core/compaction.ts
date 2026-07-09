import { type LanguageModel, generateText } from "ai";
import { AI_MAX_RETRIES } from "./model";

export interface CompactionInput {
    messages: { role: string; content: string }[];
    preserveContext: string;
}

export async function compactConversation(model: LanguageModel, input: CompactionInput): Promise<string> {
    const conversationText = input.messages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");

    const { text } = await generateText({
        model,
        maxRetries: AI_MAX_RETRIES,
        prompt: `Summarize the following conversation into a compact context that preserves all important state needed to continue the work.

MUST PRESERVE:
${input.preserveContext}

DISCARD:
- Full source file contents that have already been processed
- Verbose tool outputs from completed operations
- Redundant information

CONVERSATION:
${conversationText}

Write a concise summary that captures:
1. What has been accomplished so far
2. Current state (what's done, what's pending)
3. Key decisions made and why
4. Any important context from source files that will be needed going forward

Be concise but complete. This summary replaces the full conversation.`,
    });

    return text;
}

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export function shouldCompact(messageHistory: { role: string; content: string }[], maxTokens: number): boolean {
    const totalChars = messageHistory.reduce((sum, m) => sum + m.content.length, 0);
    return estimateTokens(String(totalChars)) > maxTokens * 0.8;
}
