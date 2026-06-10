import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentTool, FinishTool, type LanguageModel, type VideoProcessor } from "@autonoma/ai";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { type GenerationVerdict, generationVerdictSchema } from "@autonoma/types";
import type { ModelMessage } from "ai";
import type { Codebase } from "../../../codebase";
import { buildGenerationReviewMessages } from "../../../review/generation/message-builder";
import type { GenerationContext } from "../../../review/generation/types";
import type { EvidenceLoader } from "../../../review/kernel/evidence-loader";
import { tryUploadVideo } from "../../../review/kernel/video-upload";
import {
    buildCodebaseTools,
    ReadScenarioEntitiesTool,
    ViewFinalScreenshotTool,
    ViewStepScreenshotTool,
} from "../../tools";
import { ReviewerLoop } from "../reviewer-loop";

const SYSTEM_PROMPT = readFileSync(join(import.meta.dirname, "../../../review/generation/review-prompt.md"), "utf-8");

export interface GenerationReviewerConfig {
    model: LanguageModel;
    evidenceLoader: EvidenceLoader;
    videoProcessor?: VideoProcessor;
}

export interface GenerationReviewInput {
    context: GenerationContext;
    codebase: Codebase;
}

/**
 * Reviews a single generation: watches the video, walks the steps, inspects
 * the source tree, then submits a verdict via {@link FinishTool}. On a
 * no-verdict outcome the underlying agent loop throws `NoAgentResultError` /
 * `MaxStepsReached`; callers wrap and translate that into a "review failed"
 * persistence state.
 */
export class GenerationReviewer extends Agent<
    GenerationReviewInput,
    GenerationVerdict,
    ReviewerLoop<GenerationVerdict>
> {
    private readonly logger: Logger;
    private readonly model: LanguageModel;
    private readonly evidenceLoader: EvidenceLoader;
    private readonly videoProcessor?: VideoProcessor;

    private readonly viewStepScreenshotTool = new ViewStepScreenshotTool();
    private readonly viewFinalScreenshotTool = new ViewFinalScreenshotTool();
    private readonly codebaseTools = buildCodebaseTools();
    private readonly readScenarioEntitiesTool = new ReadScenarioEntitiesTool();
    private readonly resultTool = new FinishTool<GenerationVerdict>({
        name: "submit_verdict",
        description:
            "Submit your final classification of this generation. Call this exactly once when you're ready to commit to a verdict.",
        resultSchema: generationVerdictSchema,
    });

    constructor({ model, evidenceLoader, videoProcessor }: GenerationReviewerConfig) {
        super();
        this.model = model;
        this.evidenceLoader = evidenceLoader;
        this.videoProcessor = videoProcessor;
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    protected async buildUserPrompt(input: GenerationReviewInput): Promise<ModelMessage[]> {
        this.logger.info("Starting generation review", {
            generationId: input.context.generationId,
            stepCount: input.context.steps.length,
            selfReportedStatus: input.context.selfReportedStatus,
        });
        const video = await tryUploadVideo(input.context.videoUrl, this.evidenceLoader, this.videoProcessor);
        return buildGenerationReviewMessages(input.context, video);
    }

    protected async createLoop(input: GenerationReviewInput): Promise<ReviewerLoop<GenerationVerdict>> {
        const scenario = input.context.scenario;

        // The disclosure tool is only offered when a scenario was actually
        // resolved - advertising a tool with no data to read just wastes a
        // turn. The summary section in the prompt is gated the same way.
        const tools: AgentTool<unknown, unknown>[] = [
            this.viewStepScreenshotTool,
            this.viewFinalScreenshotTool,
            ...this.codebaseTools,
        ];
        if (scenario != null) tools.push(this.readScenarioEntitiesTool);

        return new ReviewerLoop<GenerationVerdict>({
            name: "GenerationReviewer",
            model: this.model,
            systemPrompt: SYSTEM_PROMPT,
            tools,
            reportTool: this.resultTool,
            codebase: input.codebase,
            screenshotLoader: this.evidenceLoader,
            steps: input.context.steps,
            finalScreenshotKey: input.context.finalScreenshotKey,
            scenarioData: scenario,
        });
    }
}
