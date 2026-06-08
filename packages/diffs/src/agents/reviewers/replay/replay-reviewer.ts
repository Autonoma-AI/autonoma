import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentTool, FinishTool, type LanguageModel, type VideoProcessor } from "@autonoma/ai";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { type ReplayVerdict, replayVerdictSchema } from "@autonoma/types";
import type { ModelMessage } from "ai";
import type { Codebase } from "../../../codebase";
import type { EvidenceLoader } from "../../../review/kernel/evidence-loader";
import { tryUploadVideo } from "../../../review/kernel/video-upload";
import { buildReplayReviewMessages } from "../../../review/replay/message-builder";
import type { RunContext } from "../../../review/replay/types";
import {
    BashTool,
    GrepTool,
    ListDirectoryTool,
    ReadFilesTool,
    ReadScenarioEntitiesTool,
    ViewFinalScreenshotTool,
    ViewStepScreenshotTool,
} from "../../tools";
import { ReviewerLoop } from "../reviewer-loop";

const SYSTEM_PROMPT = readFileSync(join(import.meta.dirname, "../../../review/replay/review-prompt.md"), "utf-8");

export interface ReplayReviewerConfig {
    model: LanguageModel;
    evidenceLoader: EvidenceLoader;
    videoProcessor?: VideoProcessor;
}

export interface ReplayReviewInput {
    context: RunContext;
    codebase: Codebase;
}

/**
 * Reviews a single replay run, deciding between `engine_error` and
 * `application_bug` (or `success`). Same shape as the generation reviewer.
 * On a no-verdict outcome the underlying agent loop throws - callers translate
 * that into a "review failed" persistence state.
 */
export class ReplayReviewer extends Agent<ReplayReviewInput, ReplayVerdict, ReviewerLoop<ReplayVerdict>> {
    private readonly logger: Logger;
    private readonly model: LanguageModel;
    private readonly evidenceLoader: EvidenceLoader;
    private readonly videoProcessor?: VideoProcessor;

    private readonly viewStepScreenshotTool = new ViewStepScreenshotTool();
    private readonly viewFinalScreenshotTool = new ViewFinalScreenshotTool();
    private readonly readFilesTool = new ReadFilesTool();
    private readonly grepTool = new GrepTool();
    private readonly listDirectoryTool = new ListDirectoryTool();
    private readonly bashTool = new BashTool();
    private readonly readScenarioEntitiesTool = new ReadScenarioEntitiesTool();
    private readonly resultTool = new FinishTool<ReplayVerdict>({
        name: "submit_verdict",
        resultSchema: replayVerdictSchema,
    });

    constructor({ model, evidenceLoader, videoProcessor }: ReplayReviewerConfig) {
        super();
        this.model = model;
        this.evidenceLoader = evidenceLoader;
        this.videoProcessor = videoProcessor;
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    protected async buildUserPrompt(input: ReplayReviewInput): Promise<ModelMessage[]> {
        this.logger.info("Starting replay review", {
            runId: input.context.runId,
            stepCount: input.context.steps.length,
        });
        const video = await tryUploadVideo(input.context.videoS3Key, this.evidenceLoader, this.videoProcessor);
        return buildReplayReviewMessages(input.context, video);
    }

    protected async createLoop(input: ReplayReviewInput): Promise<ReviewerLoop<ReplayVerdict>> {
        const scenario = input.context.scenario;

        // The disclosure tool is only offered when a scenario was actually
        // resolved - advertising a tool with no data to read just wastes a
        // turn. The summary section in the prompt is gated the same way.
        const tools: AgentTool<unknown, unknown>[] = [
            this.viewStepScreenshotTool,
            this.viewFinalScreenshotTool,
            this.readFilesTool,
            this.grepTool,
            this.listDirectoryTool,
            this.bashTool,
        ];
        if (scenario != null) tools.push(this.readScenarioEntitiesTool);

        return new ReviewerLoop<ReplayVerdict>({
            name: "ReplayReviewer",
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
