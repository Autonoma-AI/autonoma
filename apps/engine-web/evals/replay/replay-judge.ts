import { readFileSync } from "node:fs";
import { Agent, CostCollector, FinishTool, type LanguageModel, type UploadedVideo, VideoProcessor } from "@autonoma/ai";
import { createEngineModelRegistry } from "@autonoma/engine";
import type { ReplayResult } from "@autonoma/engine";
import { logger as rootLogger } from "@autonoma/logger";
import { type ScenarioData, summarizeScenarioData } from "@autonoma/scenario";
import { GoogleGenAI } from "@google/genai";
import type { FilePart, ModelMessage, TextPart } from "ai";
import { z } from "zod";
import type { ReplayWebCommandSpec } from "../../src/replay/web-command-spec";
import { env } from "../env";
import {
    type GenerationJudgeCost,
    GenerationJudgeLoop,
    type GenerationJudgeVerdict,
    type StepScreenshot,
} from "../generation/generation-judge";
const SYSTEM_PROMPT = `You are a strict eval judge for a web test replay agent.

The replay agent re-executed a previously recorded test step-by-step against a live web application. Your task is to determine whether the execution was correct according to the RUBRIC.

You have access to:
- The execution video (provided in this message) - watch it to understand the full execution
- view_step_screenshot: inspect the screenshot before or after any step (0-indexed)
- view_final_screenshot: view what the page looked like when execution ended
- read_scenario_entities: read the full entity records for a specific scenario entity type

Use these tools to verify your assessment visually. Then call submit_verdict.

The RUBRIC is your sole grading criterion. Grade ONLY what the rubric asks. Do not invent requirements beyond it.

Return passed=true only if every applicable rubric point is satisfied. If a rubric point cannot be evaluated from the available evidence, treat it as satisfied.`;

const replayJudgeVerdictSchema = z.object({
    passed: z.boolean(),
    confidence: z.number().min(0).max(1).describe("Your confidence in this verdict, 0-1"),
    reasoning: z.string().describe("Concise explanation citing specific rubric points that passed or failed"),
});

export interface ReplayJudgeResult extends GenerationJudgeVerdict {
    cost: GenerationJudgeCost;
}

export interface ReplayJudgeInput {
    result: ReplayResult<ReplayWebCommandSpec>;
    videoPath: string;
    rawPrompt: string;
    rubric: string;
    scenarioData?: ScenarioData;
}

/**
 * Vision-enabled LLM judge for replay eval cases.
 * Reuses GenerationJudgeLoop (and its tools) with a replay-specific system prompt.
 */
export class ReplayJudge extends Agent<ReplayJudgeInput, GenerationJudgeVerdict, GenerationJudgeLoop> {
    private readonly logger = rootLogger.child({ name: this.constructor.name });
    private readonly costCollector = new CostCollector();
    private readonly model: LanguageModel;
    private readonly videoProcessor: VideoProcessor;
    private readonly resultTool = new FinishTool<GenerationJudgeVerdict>({
        name: "submit_verdict",
        description: "Submit your final verdict on whether the replay passed the rubric criteria.",
        resultSchema: replayJudgeVerdictSchema,
    });

    constructor(model?: LanguageModel) {
        super();
        const registry = createEngineModelRegistry(this.costCollector);
        this.model = model ?? registry.getModel({ model: "smart-visual", tag: "replay-judge" });
        this.videoProcessor = new VideoProcessor(new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }));
    }

    public async grade(input: ReplayJudgeInput): Promise<ReplayJudgeResult> {
        this.logger.info("Running replay judge", {
            extra: {
                stepCount: input.result.state.executedSteps.length,
                success: input.result.success,
            },
        });
        const { result } = await this.run(input);
        const cost = summarizeJudgeCost(this.costCollector);
        this.logger.info("Judge verdict", { extra: { passed: result.passed, confidence: result.confidence, cost } });
        return { ...result, cost };
    }

    protected async buildUserPrompt(input: ReplayJudgeInput): Promise<ModelMessage[]> {
        const video = await this.tryUploadVideo(input.videoPath);

        const parts: (TextPart | FilePart)[] = [];
        if (video != null) {
            parts.push({ type: "file", data: video.uri, mediaType: video.mimeType });
            parts.push({ type: "text", text: "The video above shows the complete replay recording." });
        }
        parts.push({ type: "text", text: buildJudgeContext(input) });

        return [
            { role: "user", content: parts },
            { role: "user", content: "Examine the evidence and submit your verdict." },
        ];
    }

    protected async createLoop(input: ReplayJudgeInput): Promise<GenerationJudgeLoop> {
        const stepScreenshots = collectReplayStepScreenshots(input.result);
        const lastResult = input.result.state.executionResults.at(-1);
        const finalScreenshotBase64 = lastResult?.screenshotAfter?.base64;
        return new GenerationJudgeLoop(
            this.model,
            this.resultTool,
            stepScreenshots,
            finalScreenshotBase64,
            input.scenarioData,
            SYSTEM_PROMPT,
            "ReplayJudge",
        );
    }

    private async tryUploadVideo(videoPath: string): Promise<UploadedVideo | undefined> {
        try {
            const buffer = readFileSync(videoPath);
            const arrayBuffer = buffer.buffer.slice(
                buffer.byteOffset,
                buffer.byteOffset + buffer.byteLength,
            ) as ArrayBuffer;
            return await this.videoProcessor.uploadVideo({
                data: { type: "buffer", buffer: arrayBuffer },
                mimeType: "video/webm",
            });
        } catch (err) {
            this.logger.warn("Failed to upload video, continuing without it", { extra: { videoPath, err } });
            return undefined;
        }
    }
}

function summarizeJudgeCost(costCollector: CostCollector): GenerationJudgeCost {
    return costCollector.getRecords().reduce<GenerationJudgeCost>(
        (acc, record) => ({
            callCount: acc.callCount + 1,
            costMicrodollars: acc.costMicrodollars + record.costMicrodollars,
            inputTokens: acc.inputTokens + record.inputTokens,
            outputTokens: acc.outputTokens + record.outputTokens,
        }),
        { callCount: 0, costMicrodollars: 0, inputTokens: 0, outputTokens: 0 },
    );
}

function collectReplayStepScreenshots(result: ReplayResult<ReplayWebCommandSpec>): StepScreenshot[] {
    return result.state.executionResults.map((r, index) => ({
        stepIndex: index,
        before: r.screenshotBefore?.base64 ?? "",
        after: r.screenshotAfter?.base64 ?? "",
    }));
}

function buildJudgeContext(input: ReplayJudgeInput): string {
    const sections: string[] = [];

    sections.push(`## Test Plan\n\n${input.rawPrompt}`);

    const passedSteps = input.result.state.executionResults.filter((r) => r.status === "passed").length;
    const totalSteps = input.result.state.executionResults.length;
    const summaryLines = [
        `- Result: ${input.result.success ? "success" : "failed"}`,
        `- Steps passed: ${passedSteps} / ${totalSteps}`,
    ];
    if (input.result.reasoning != null) {
        summaryLines.push(`- Reasoning: ${input.result.reasoning}`);
    }
    sections.push(`## Replay Summary\n\n${summaryLines.join("\n")}`);

    if (input.scenarioData != null) {
        sections.push(`## Scenario Data\n\n${summarizeScenarioData(input.scenarioData)}`);
    }

    sections.push(`## Rubric\n\n${input.rubric}`);

    return sections.join("\n\n");
}
