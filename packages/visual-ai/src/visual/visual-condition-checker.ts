import { ObjectGenerator, type ObjectGeneratorConfig } from "@autonoma/ai";
import type { Screenshot } from "@autonoma/image";
import z from "zod";

const DEFAULT_VISUAL_CHECK_PROMPT =
    "You are a UI analysis expert. You will receive an image and a condition. The image is a screenshot of an application, and your task is to decide whether the condition is met or not.";

const visualCheckResult = z.object({
    metCondition: z.boolean().describe("whether the condition was met"),
    reason: z.string().describe("explanation of why the condition was met or not"),
});
type VisualCheckResult = z.infer<typeof visualCheckResult>;

export interface VisualConditionCheckerConfig extends Pick<ObjectGeneratorConfig<VisualCheckResult>, "model"> {
    systemPrompt?: string;
}

/**
 * A model that checks if a condition is met on a given screenshot.
 */
export class VisualConditionChecker extends ObjectGenerator<VisualCheckResult> {
    constructor(config: VisualConditionCheckerConfig) {
        super({
            ...config,
            systemPrompt: config.systemPrompt ?? DEFAULT_VISUAL_CHECK_PROMPT,
            schema: visualCheckResult,
        });
    }

    async checkCondition(condition: string, image: Screenshot): Promise<VisualCheckResult> {
        return this.generate({ images: [image], userPrompt: condition });
    }
}
