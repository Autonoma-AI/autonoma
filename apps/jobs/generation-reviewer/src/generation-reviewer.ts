import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel, UploadedVideo, VideoProcessor } from "@autonoma/ai";
import { logger } from "@autonoma/logger";
import {
    type ScreenshotLoader,
    type VideoDownloader,
    buildReviewTools,
    runReviewAgent,
    tryUploadVideo,
} from "@autonoma/review";
import type { ReviewVerdict } from "@autonoma/types";
import type { FilePart, ModelMessage, TextPart } from "ai";
import type { GenerationData } from "./data-loader";

const systemPrompt = readFileSync(join(import.meta.dirname, "review-prompt.md"), "utf-8");

export interface ReviewResult {
    verdict: ReviewVerdict | undefined;
    generationId: string;
}

export class GenerationReviewer {
    constructor(
        private readonly model: LanguageModel,
        private readonly dataLoader: ScreenshotLoader & VideoDownloader,
        private readonly videoProcessor?: VideoProcessor,
    ) {}

    async review(data: GenerationData): Promise<ReviewResult> {
        logger.info("Starting generation review", { generationId: data.generationId, stepCount: data.steps.length });

        const video = await tryUploadVideo(data.videoUrl, this.dataLoader, this.videoProcessor);
        const messages = this.buildMessages(data, video);
        const tools = buildReviewTools({
            screenshotLoader: this.dataLoader,
            steps: data.steps,
            finalScreenshotKey: data.finalScreenshotKey,
        });

        logger.info("Running reviewer agent", { messageCount: messages.length });

        const { verdict } = await runReviewAgent(this.model, systemPrompt, tools, messages);

        logger.info("Review completed", { verdict: verdict?.verdict, generationId: data.generationId });

        return { verdict, generationId: data.generationId };
    }

    private buildMessages(data: GenerationData, video?: UploadedVideo): ModelMessage[] {
        const contextParts: Array<TextPart | FilePart> = [];

        contextParts.push({
            type: "text",
            text: `## Test Plan\n\n${data.testPlanPrompt}`,
        });

        if (video != null) {
            contextParts.push({
                type: "file",
                data: video.uri,
                mediaType: video.mimeType,
            });
            contextParts.push({
                type: "text",
                text: "The video above shows the complete execution recording.",
            });
        }

        const stepSummary = this.buildStepSummary(data);
        contextParts.push({
            type: "text",
            text: `## Step Summary\n\n${stepSummary}`,
        });

        if (data.reasoning != null) {
            contextParts.push({
                type: "text",
                text: `## Agent's Final Reasoning\n\n${data.reasoning}`,
            });
        }

        contextParts.push({
            type: "text",
            text: "## Agent Conversation\n\nThe following messages are the execution agent's conversation during the test run. Review them to understand its reasoning and actions.",
        });

        const conversationMessages = this.sanitizeConversation(data.conversation);

        return [
            { role: "user", content: contextParts },
            ...conversationMessages,
            {
                role: "user",
                content:
                    "The agent conversation above is now complete. Analyze the test execution and submit your verdict.",
            },
        ];
    }

    private buildStepSummary(data: GenerationData): string {
        if (data.steps.length === 0) return "No steps were executed.";

        return data.steps
            .map((step) => {
                const output = step.output as Record<string, unknown> | undefined;
                const success = output?.success ?? "unknown";
                const result = output?.result ?? output?.error ?? "";
                const hasScreenshots = step.screenshotBeforeKey != null || step.screenshotAfterKey != null;

                return [
                    `### Step ${step.order}: ${step.interaction}`,
                    `- **Parameters**: ${JSON.stringify(step.params)}`,
                    `- **Success**: ${success}`,
                    `- **Result**: ${JSON.stringify(result)}`,
                    hasScreenshots ? "- Screenshots available (use view_step_screenshot tool to inspect)" : "",
                ]
                    .filter(Boolean)
                    .join("\n");
            })
            .join("\n\n");
    }

    private sanitizeConversation(conversation: ModelMessage[]): ModelMessage[] {
        return conversation.map((message) => {
            if (!Array.isArray(message.content)) {
                return { role: message.role, content: message.content } as ModelMessage;
            }

            const filteredContent = message.content
                .filter((part) => {
                    const partType = (part as { type: string }).type;
                    return partType !== "image";
                })
                .map((part) => {
                    const { providerOptions: _providerOptions, ...rest } = part as Record<string, unknown>;
                    return rest;
                });

            return { role: message.role, content: filteredContent } as ModelMessage;
        });
    }
}
