import { ObjectGenerator, type LanguageModel } from "@autonoma/ai";
import type { Screenshot } from "@autonoma/image";
import z from "zod";

const TEXT_EXTRACTION_SYSTEM_PROMPT =
    "You are a UI text extraction expert. You will receive a screenshot of an application and a description " +
    "of a text element on screen. Your task is to extract the exact text value described. " +
    "Return the raw value only — not a description of it. For example, if asked for " +
    '"the order ID in the confirmation banner", return "ORD-12345", not "The order ID is ORD-12345".';

const textExtractionResult = z.object({
    value: z.string().describe("The exact text value extracted from the screenshot"),
});

type TextExtractionResult = z.infer<typeof textExtractionResult>;

/**
 * Extracts text values from screenshots using AI vision.
 * Used by the `read` command to store dynamic values in the agent's memory.
 */
export class TextExtractor extends ObjectGenerator<TextExtractionResult> {
    constructor(model: LanguageModel) {
        super({
            model,
            schema: textExtractionResult,
            systemPrompt: TEXT_EXTRACTION_SYSTEM_PROMPT,
        });
    }

    async extractText(description: string, image: Screenshot): Promise<TextExtractionResult> {
        return this.generate({ images: [image], userPrompt: description });
    }
}
