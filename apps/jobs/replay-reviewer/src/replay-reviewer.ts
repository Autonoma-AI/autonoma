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
import type { RunReviewData } from "./data-loader";

const systemPrompt = readFileSync(join(import.meta.dirname, "review-prompt.md"), "utf-8");

export interface RunReviewResult {
    verdict: ReviewVerdict | undefined;
    runId: string;
}

export class ReplayReviewer {
    constructor(
        private readonly model: LanguageModel,
        private readonly dataLoader: ScreenshotLoader & VideoDownloader,
        private readonly videoProcessor?: VideoProcessor,
    ) {}

    async review(data: RunReviewData): Promise<RunReviewResult> {
        logger.info("Starting replay review", { runId: data.runId, stepCount: data.steps.length });

        const video = await tryUploadVideo(data.videoS3Key, this.dataLoader, this.videoProcessor);
        const messages = this.buildMessages(data, video);
        const tools = buildReviewTools({
            screenshotLoader: this.dataLoader,
            steps: data.steps,
            finalScreenshotKey: data.finalScreenshotKey,
        });

        logger.info("Running replay reviewer agent", { messageCount: messages.length });

        const { verdict } = await runReviewAgent(this.model, systemPrompt, tools, messages);

        logger.info("Replay review completed", { verdict: verdict?.verdict, runId: data.runId });

        return { verdict, runId: data.runId };
    }

    private buildMessages(data: RunReviewData, video?: UploadedVideo): ModelMessage[] {
        const contextParts: Array<TextPart | FilePart> = [];

        contextParts.push({
            type: "text",
            text: `## Test Plan\n\n${data.testPlanPrompt}`,
        });

        contextParts.push({
            type: "text",
            text: `## Test Case\n\n**Name:** ${data.testCaseName}`,
        });

        if (video != null) {
            contextParts.push({
                type: "file",
                data: video.uri,
                mediaType: video.mimeType,
            });
            contextParts.push({
                type: "text",
                text: "The video above shows the complete replay recording.",
            });
        }

        const stepSummary = this.buildStepSummary(data);
        contextParts.push({
            type: "text",
            text: `## Step Summary\n\n${stepSummary}`,
        });

        return [
            { role: "user", content: contextParts },
            {
                role: "user",
                content:
                    "The step summary above shows all steps that were executed during the replay. Analyze the replay execution and submit your verdict.",
            },
        ];
    }

    private buildStepSummary(data: RunReviewData): string {
        if (data.steps.length === 0) return "No steps were executed.";

        return data.steps
            .map((step) => {
                const output = step.output as Record<string, unknown> | undefined;
                const outcome = output?.outcome ?? "unknown";
                const hasScreenshots = step.screenshotBeforeKey != null || step.screenshotAfterKey != null;

                return [
                    `### Step ${step.order}: ${step.interaction}`,
                    `- **Parameters**: ${JSON.stringify(step.params)}`,
                    `- **Output**: ${JSON.stringify(output)}`,
                    `- **Outcome**: ${outcome}`,
                    hasScreenshots ? "- Screenshots available (use view_step_screenshot tool to inspect)" : "",
                ]
                    .filter(Boolean)
                    .join("\n");
            })
            .join("\n\n");
    }
}
