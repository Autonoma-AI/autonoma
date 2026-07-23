import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    Agent,
    type AgentRunResult,
    type AgentTool,
    FinishTool,
    type LanguageModel,
    type VideoModel,
    type VideoUploader,
} from "@autonoma/ai";
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
    /** The video-capable model paired with its uploader. The reviewer runs on `videoModel.model`. */
    videoModel: VideoModel;
    evidenceLoader: EvidenceLoader;
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
    private readonly videoUploader: VideoUploader;

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

    constructor({ videoModel, evidenceLoader }: GenerationReviewerConfig) {
        super();
        this.model = videoModel.model;
        this.videoUploader = videoModel.uploader;
        this.evidenceLoader = evidenceLoader;
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Run the reviewer, then enforce the `scenario_unsupported` guardrail: that
     * verdict is anchored on the test case's loop-stable description, so when the
     * description is missing (an older case not yet backfilled) there is no stable
     * intent to ground the claim on. Rather than trust the model to never emit it,
     * we deterministically downgrade such a verdict to `plan_mismatch` here - the
     * catch-all for "the data the plan needs is not there". This is a defensive
     * guard against the un-backfilled gap, not an endorsement of description-less
     * test cases; once descriptions are backfilled it simply stops firing.
     */
    public override async run(input: GenerationReviewInput): Promise<AgentRunResult<GenerationVerdict>> {
        const outcome = await super.run(input);
        const verdict = outcome.result;

        const hasDescription =
            input.context.testCaseDescription != null && input.context.testCaseDescription.trim().length > 0;
        if (verdict.verdict !== "scenario_unsupported" || hasDescription) return outcome;

        this.logger.warn(
            "Downgrading scenario_unsupported to plan_mismatch: test case has no description to anchor it",
            {
                generationId: input.context.generationId,
            },
        );
        const downgraded: GenerationVerdict = {
            verdict: "plan_mismatch",
            title: verdict.title,
            reasoning: `[Downgraded from scenario_unsupported: the test case has no description anchoring its intent, so a data gap is treated as a plan mismatch.] ${verdict.reasoning}`,
            failurePoint: verdict.failurePoint,
            evidence: verdict.evidence,
        };
        return { result: downgraded, conversation: outcome.conversation };
    }

    protected async buildUserPrompt(input: GenerationReviewInput): Promise<ModelMessage[]> {
        this.logger.info("Starting generation review", {
            generationId: input.context.generationId,
            stepCount: input.context.steps.length,
            selfReportedStatus: input.context.selfReportedStatus,
        });
        const video = await tryUploadVideo(
            input.context.videoUrl,
            input.context.optimizedVideoUrl,
            this.evidenceLoader,
            this.videoUploader,
        );
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
            architecture: input.context.architecture,
        });
    }
}
