import type { FilePart, ModelMessage, TextPart, UploadedVideo } from "@autonoma/ai";

type Part = TextPart | FilePart;

/**
 * Fluent builder for the user-facing context messages in a review agent prompt.
 *
 * Reviewers compose a single seeded user message of mixed text/video parts,
 * optionally splice in conversation history, and finish with a "now decide"
 * sentinel. This builder isolates that ceremony from the reviewer classes so
 * each reviewer's `buildMessages()` reads as a script rather than a 50-line
 * imperative blob.
 */
export class MessageBuilder {
    private readonly parts: Part[] = [];
    private readonly trailingMessages: ModelMessage[] = [];

    section(title: string, body: string): this {
        this.parts.push({ type: "text", text: `## ${title}\n\n${body}` });
        return this;
    }

    text(text: string): this {
        this.parts.push({ type: "text", text });
        return this;
    }

    video(video: UploadedVideo | undefined, caption: string): this {
        if (video == null) return this;
        this.parts.push({ type: "file", data: video.uri, mediaType: video.mimeType });
        this.parts.push({ type: "text", text: caption });
        return this;
    }

    /** Append already-formed messages (e.g. an execution agent's prior conversation). */
    append(...messages: ModelMessage[]): this {
        this.trailingMessages.push(...messages);
        return this;
    }

    /** Add a final "now decide" sentinel as a user message. */
    closingPrompt(text: string): this {
        this.trailingMessages.push({ role: "user", content: text });
        return this;
    }

    build(): ModelMessage[] {
        return [{ role: "user", content: this.parts }, ...this.trailingMessages];
    }
}

/**
 * Drop image parts and providerOptions from a foreign agent conversation
 * before splicing it into a review prompt. The screenshot tools let the
 * reviewer fetch images on demand; embedding them inline blows up the prompt.
 */
export function sanitizeConversation(conversation: ModelMessage[]): ModelMessage[] {
    return conversation.map((message) => {
        if (!Array.isArray(message.content)) {
            return { role: message.role, content: message.content } as ModelMessage;
        }

        const filteredContent = message.content
            .filter((part) => (part as { type: string }).type !== "image")
            .map((part) => {
                const { providerOptions: _providerOptions, ...rest } = part as Record<string, unknown>;
                return rest;
            });

        return { role: message.role, content: filteredContent } as ModelMessage;
    });
}
