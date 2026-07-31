import type { ModelMessage } from "@autonoma/ai";
import { describe, expect, it } from "vitest";
import { MessageBuilder, sanitizeConversation } from "../src/review/kernel/message-builder";

describe("MessageBuilder", () => {
    it("groups text and video parts into a single user message, then appends extras", () => {
        const messages = new MessageBuilder()
            .section("Plan", "do the thing")
            .section("Outcome", "it failed")
            .closingPrompt("decide")
            .build();

        expect(messages).toHaveLength(2);
        const first = messages[0]!;
        expect(first.role).toBe("user");
        expect(Array.isArray(first.content)).toBe(true);
        const parts = first.content as Array<{ type: string; text: string }>;
        expect(parts).toHaveLength(2);
        expect(parts[0]!.text).toContain("## Plan");
        expect(parts[1]!.text).toContain("## Outcome");

        expect(messages[1]).toEqual({ role: "user", content: "decide" });
    });

    it("adds video file + caption when present, omits when undefined", () => {
        const withVideo = new MessageBuilder()
            .video({ uri: "gs://bucket/v", mimeType: "video/webm" }, "video shown above")
            .build();
        const parts = withVideo[0]!.content as Array<{ type: string }>;
        expect(parts.find((p) => p.type === "file")).toBeDefined();
        expect(parts.find((p) => p.type === "text")).toBeDefined();

        const withoutVideo = new MessageBuilder().video(undefined, "ignored").build();
        expect((withoutVideo[0]!.content as unknown[]).length).toBe(0);
    });

    it("appends pre-built messages between context and closingPrompt", () => {
        const prior: ModelMessage[] = [
            { role: "assistant", content: "I clicked the button" },
            { role: "user", content: "ok" },
        ];
        const messages = new MessageBuilder()
            .section("Plan", "do thing")
            .append(...prior)
            .closingPrompt("decide")
            .build();

        expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    });
});

describe("sanitizeConversation", () => {
    it("strips image parts and providerOptions, leaves string content untouched", () => {
        const conversation: ModelMessage[] = [
            { role: "user", content: "hello" },
            {
                role: "assistant",
                content: [
                    { type: "text", text: "I see this" },
                    { type: "image", image: "binary..." },
                    { type: "text", text: "and this", providerOptions: { google: { thinking: true } } },
                ],
            } as ModelMessage,
        ];
        const sanitized = sanitizeConversation(conversation);

        expect(sanitized[0]).toEqual({ role: "user", content: "hello" });

        const assistantParts = sanitized[1]!.content as Array<{ type: string; text?: string }>;
        expect(assistantParts).toHaveLength(2);
        expect(assistantParts.every((p) => p.type !== "image")).toBe(true);
        expect((assistantParts[1]! as Record<string, unknown>).providerOptions).toBeUndefined();
    });
});
