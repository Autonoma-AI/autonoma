import type { PrismaClient } from "@autonoma/db";
import type { GenerationContext, GenerationStepData } from "@autonoma/diffs";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import type { ModelMessage } from "ai";

/**
 * Loads everything the reviewer needs from Postgres + S3, and projects it into
 * a single read-only GenerationContext. Stays out of message construction and
 * agent invocation so it's trivially testable in isolation.
 */
export class GenerationContextLoader {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly storage: StorageProvider,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async load(generationId: string): Promise<GenerationContext> {
        this.logger.info("Loading generation context", { generationId });

        const generation = await this.db.testGeneration.findUniqueOrThrow({
            where: { id: generationId },
            select: {
                id: true,
                status: true,
                reasoning: true,
                videoUrl: true,
                finalScreenshot: true,
                conversationUrl: true,
                organizationId: true,
                testPlan: { select: { prompt: true } },
                steps: {
                    select: {
                        list: {
                            select: {
                                order: true,
                                interaction: true,
                                params: true,
                                screenshotBefore: true,
                                screenshotAfter: true,
                                outputs: { select: { output: true }, take: 1 },
                            },
                            orderBy: { order: "asc" },
                        },
                    },
                },
            },
        });

        const steps: GenerationStepData[] = (generation.steps?.list ?? []).map((input) => ({
            order: input.order,
            interaction: input.interaction,
            params: input.params,
            output: input.outputs[0]?.output,
            screenshotBeforeKey: input.screenshotBefore ?? undefined,
            screenshotAfterKey: input.screenshotAfter ?? undefined,
        }));

        const conversation = await this.loadConversation(generation.conversationUrl);

        this.logger.info("Generation context loaded", {
            stepCount: steps.length,
            selfReportedStatus: generation.status,
        });

        return {
            generationId: generation.id,
            organizationId: generation.organizationId,
            selfReportedStatus: generation.status,
            testPlanPrompt: generation.testPlan.prompt,
            conversation,
            reasoning: generation.reasoning ?? undefined,
            videoUrl: generation.videoUrl ?? undefined,
            finalScreenshotKey: generation.finalScreenshot ?? undefined,
            steps,
        };
    }

    private async loadConversation(conversationUrl: string | null): Promise<ModelMessage[]> {
        if (conversationUrl == null) {
            this.logger.warn("No conversation URL found - returning empty conversation");
            return [];
        }
        this.logger.info("Downloading execution conversation", { conversationUrl });
        const buffer = await this.storage.download(conversationUrl);
        return JSON.parse(buffer.toString("utf-8")) as ModelMessage[];
    }

    async loadScreenshot(s3Key: string): Promise<Buffer> {
        return this.storage.download(s3Key);
    }

    async downloadVideo(s3Key: string): Promise<Buffer> {
        return this.storage.download(s3Key);
    }
}
