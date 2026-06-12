import { readFileSync } from "node:fs";
import {
    Agent,
    AgentLoop,
    AgentTool,
    type AgentToolModelOutput,
    type AgentToolModelOutputOptions,
    CostCollector,
    FinishTool,
    FixableToolError,
    type LanguageModel,
    type UploadedVideo,
    VideoProcessor,
} from "@autonoma/ai";
import { createEngineModelRegistry } from "@autonoma/engine";
import type { ExecutionResult } from "@autonoma/engine";
import { logger as rootLogger } from "@autonoma/logger";
import { type ScenarioData, type ScenarioEntityRecord, boundRecords, summarizeScenarioData } from "@autonoma/scenario";
import { GoogleGenAI } from "@google/genai";
import type { FilePart, ModelMessage, TextPart } from "ai";
import { z } from "zod";
import type { WebCommandSpec } from "../../src/execution-agent/web-agent";
import { env } from "../env";

const SYSTEM_PROMPT = `You are a strict eval judge for a web test generation agent.

The agent was given a natural-language test plan and executed it step-by-step against a live web application. Your task is to determine whether the execution was correct according to the RUBRIC.

You have access to:
- The execution video (provided in this message) - watch it to understand the full execution
- view_step_screenshot: inspect the screenshot before or after any step (0-indexed)
- view_final_screenshot: view what the page looked like when execution ended
- read_scenario_entities: read the full entity records for a specific scenario entity type

Use these tools to verify your assessment visually. Then call submit_verdict.

The RUBRIC is your sole grading criterion. Grade ONLY what the rubric asks. Do not invent requirements beyond it.

Return passed=true only if every applicable rubric point is satisfied. If a rubric point cannot be evaluated from the available evidence, treat it as satisfied.`;

const generationJudgeVerdictSchema = z.object({
    passed: z.boolean(),
    confidence: z.number().min(0).max(1).describe("Your confidence in this verdict, 0-1"),
    reasoning: z.string().describe("Concise explanation citing specific rubric points that passed or failed"),
});

export type GenerationJudgeVerdict = z.infer<typeof generationJudgeVerdictSchema>;

export interface GenerationJudgeCost {
    callCount: number;
    costMicrodollars: number;
    inputTokens: number;
    outputTokens: number;
}

export interface GenerationJudgeResult extends GenerationJudgeVerdict {
    cost: GenerationJudgeCost;
}

export interface StepScreenshot {
    stepIndex: number;
    before: string;
    after: string;
}

export interface GenerationJudgeInput {
    result: ExecutionResult<WebCommandSpec>;
    videoPath: string;
    rawPrompt: string;
    rubric: string;
    /** Scenario name + resolved create graph, used as grounding context. */
    scenarioData?: ScenarioData;
}

// ---------------------------------------------------------------------------
// Screenshot tools
// ---------------------------------------------------------------------------

type ViewStepInput = { stepIndex: number; timing: "before" | "after" };
type ViewStepOutput = { found: false } | { found: true; base64: string };

class InMemoryViewStepScreenshotTool extends AgentTool<ViewStepInput, ViewStepOutput, GenerationJudgeLoop> {
    constructor() {
        super({
            name: "view_step_screenshot",
            description:
                "View the screenshot before or after a step (0-indexed). Use this to visually inspect the application state at any point during execution.",
            inputSchema: z.object({
                stepIndex: z.number().int().min(0).describe("The step index (0-indexed)"),
                timing: z.enum(["before", "after"]).describe("View before or after the step executed"),
            }),
        });
    }

    protected async execute({ stepIndex, timing }: ViewStepInput, loop: GenerationJudgeLoop): Promise<ViewStepOutput> {
        const ss = loop.stepScreenshots[stepIndex];
        if (ss == null) return { found: false };
        const base64 = timing === "before" ? ss.before : ss.after;
        return { found: true, base64 };
    }

    protected override toModelOutput({
        output,
    }: AgentToolModelOutputOptions<ViewStepInput, ViewStepOutput>): AgentToolModelOutput<
        ViewStepInput,
        ViewStepOutput
    > {
        if (!output.success) return { type: "error-json", value: { success: false, error: output.error } };
        if (!output.result.found) return { type: "text", value: "No screenshot available for that step/timing" };
        return {
            type: "content",
            value: [
                { type: "text", text: "Step screenshot:" },
                { type: "media", data: output.result.base64, mediaType: "image/png" },
            ],
        };
    }
}

type ViewFinalInput = Record<string, never>;
type ViewFinalOutput = { found: false } | { found: true; base64: string };

class InMemoryViewFinalScreenshotTool extends AgentTool<ViewFinalInput, ViewFinalOutput, GenerationJudgeLoop> {
    constructor() {
        super({
            name: "view_final_screenshot",
            description: "View the final screenshot - what the application looked like when execution ended.",
            inputSchema: z.object({}),
        });
    }

    protected async execute(_input: ViewFinalInput, loop: GenerationJudgeLoop): Promise<ViewFinalOutput> {
        if (loop.finalScreenshotBase64 == null) return { found: false };
        return { found: true, base64: loop.finalScreenshotBase64 };
    }

    protected override toModelOutput({
        output,
    }: AgentToolModelOutputOptions<ViewFinalInput, ViewFinalOutput>): AgentToolModelOutput<
        ViewFinalInput,
        ViewFinalOutput
    > {
        if (!output.success) return { type: "error-json", value: { success: false, error: output.error } };
        if (!output.result.found) return { type: "text", value: "No final screenshot available" };
        return {
            type: "content",
            value: [
                { type: "text", text: "Final screenshot:" },
                { type: "media", data: output.result.base64, mediaType: "image/png" },
            ],
        };
    }
}

// ---------------------------------------------------------------------------
// Scenario entities tool
// ---------------------------------------------------------------------------

const MAX_ENTITIES_OUTPUT_CHARS = 60_000;

type ReadEntitiesInput = { entityType: string };
type ReadEntitiesOutput = {
    entityType: string;
    count: number;
    records: ScenarioEntityRecord[];
    truncated?: boolean;
    note?: string;
};

class NoScenarioDataError extends FixableToolError {
    constructor() {
        super("This run has no resolved scenario data, so there are no entities to read.");
    }

    override suggestFix(): string {
        return "Do not call read_scenario_entities for this run - decide the verdict from the steps and video instead.";
    }
}

class UnknownEntityTypeError extends FixableToolError {
    constructor(
        public readonly entityType: string,
        public readonly availableTypes: string[],
    ) {
        super(`Unknown scenario entity type "${entityType}".`);
    }

    override suggestFix(): string {
        if (this.availableTypes.length === 0) {
            return "The scenario created no entity types - there is nothing to read.";
        }
        return `Available entity types: ${this.availableTypes.join(", ")}. Try again with one of those.`;
    }
}

class ReadScenarioEntitiesTool extends AgentTool<ReadEntitiesInput, ReadEntitiesOutput, GenerationJudgeLoop> {
    constructor() {
        super({
            name: "read_scenario_entities",
            description:
                "Read the full records the scenario created for a single entity type. " +
                "The scenario-data summary in the prompt lists each type with a bounded preview; call this " +
                "to see every field of every record for one type. Reads from in-memory scenario data only.",
            inputSchema: z.object({
                entityType: z
                    .string()
                    .describe("The entity type to read, e.g. 'User'. Must be listed in the scenario data summary."),
            }),
        });
    }

    protected async execute({ entityType }: ReadEntitiesInput, loop: GenerationJudgeLoop): Promise<ReadEntitiesOutput> {
        const data = loop.scenarioData;
        if (data == null) throw new NoScenarioDataError();

        const records = data.entities[entityType];
        if (records == null) throw new UnknownEntityTypeError(entityType, Object.keys(data.entities));

        const bounded = boundRecords(records, MAX_ENTITIES_OUTPUT_CHARS);
        if (!bounded.truncated) {
            return { entityType, count: bounded.count, records: bounded.records };
        }

        return {
            entityType,
            count: bounded.count,
            records: bounded.records,
            truncated: true,
            note: `Returned the first ${bounded.records.length} of ${bounded.count} ${entityType} records; the rest exceeded the output budget.`,
        };
    }
}

// ---------------------------------------------------------------------------
// Agent loop - holds in-memory screenshots and scenario data for the tools
// ---------------------------------------------------------------------------

export class GenerationJudgeLoop extends AgentLoop<GenerationJudgeVerdict> {
    constructor(
        model: LanguageModel,
        resultTool: FinishTool<GenerationJudgeVerdict>,
        readonly stepScreenshots: StepScreenshot[],
        readonly finalScreenshotBase64: string | undefined,
        readonly scenarioData: ScenarioData | undefined,
        systemPrompt: string = SYSTEM_PROMPT,
        name: string = "GenerationJudge",
    ) {
        super({
            name,
            model,
            systemPrompt,
            tools: [
                new InMemoryViewStepScreenshotTool(),
                new InMemoryViewFinalScreenshotTool(),
                new ReadScenarioEntitiesTool(),
            ],
            reportTool: resultTool,
            maxSteps: 20,
        });
    }
}

// ---------------------------------------------------------------------------
// Judge agent
// ---------------------------------------------------------------------------

/**
 * Vision-enabled LLM judge for generation eval cases.
 */
export class GenerationJudge extends Agent<GenerationJudgeInput, GenerationJudgeVerdict, GenerationJudgeLoop> {
    private readonly logger = rootLogger.child({ name: this.constructor.name });
    private readonly costCollector = new CostCollector();
    private readonly model: LanguageModel;
    private readonly videoProcessor: VideoProcessor;
    private readonly resultTool = new FinishTool<GenerationJudgeVerdict>({
        name: "submit_verdict",
        description: "Submit your final verdict on whether the generation passed the rubric criteria.",
        resultSchema: generationJudgeVerdictSchema,
    });

    constructor(model?: LanguageModel) {
        super();
        const registry = createEngineModelRegistry(this.costCollector);
        this.model = model ?? registry.getModel({ model: "smart-visual", tag: "generation-judge" });
        this.videoProcessor = new VideoProcessor(new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }));
    }

    public async grade(input: GenerationJudgeInput): Promise<GenerationJudgeResult> {
        this.logger.info("Running generation judge", {
            extra: { stepCount: input.result.generatedSteps.length, finishReason: input.result.finishReason },
        });
        const { result } = await this.run(input);
        const cost = summarizeJudgeCost(this.costCollector);
        this.logger.info("Judge verdict", { extra: { passed: result.passed, confidence: result.confidence, cost } });
        return { ...result, cost };
    }

    protected async buildUserPrompt(input: GenerationJudgeInput): Promise<ModelMessage[]> {
        const video = await this.tryUploadVideo(input.videoPath);

        const parts: (TextPart | FilePart)[] = [];
        if (video != null) {
            parts.push({ type: "file", data: video.uri, mediaType: video.mimeType });
            parts.push({ type: "text", text: "The video above shows the complete execution recording." });
        }
        parts.push({ type: "text", text: buildJudgeContext(input) });

        return [
            { role: "user", content: parts },
            { role: "user", content: "Examine the evidence and submit your verdict." },
        ];
    }

    protected async createLoop(input: GenerationJudgeInput): Promise<GenerationJudgeLoop> {
        const stepScreenshots = collectStepScreenshots(input.result);
        const finalScreenshotBase64 = input.result.finalScreenshot?.base64;
        return new GenerationJudgeLoop(
            this.model,
            this.resultTool,
            stepScreenshots,
            finalScreenshotBase64,
            input.scenarioData,
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

function collectStepScreenshots(result: ExecutionResult<WebCommandSpec>): StepScreenshot[] {
    return result.generatedSteps
        .filter((s) => s.status === "success")
        .map((step, index) => ({
            stepIndex: index,
            before: step.beforeMetadata.screenshot.base64,
            after: step.afterMetadata.screenshot.base64,
        }));
}

function buildJudgeContext(input: GenerationJudgeInput): string {
    const sections: string[] = [];

    sections.push(`## Test Plan\n\n${input.rawPrompt}`);

    const successCount = input.result.generatedSteps.filter((s) => s.status === "success").length;
    const summaryLines = [`- Finish reason: \`${input.result.finishReason}\``, `- Successful steps: ${successCount}`];
    if (input.result.reasoning != null) {
        summaryLines.push(`- Agent reasoning: ${input.result.reasoning}`);
    }
    sections.push(`## Execution Summary\n\n${summaryLines.join("\n")}`);

    if (input.scenarioData != null) {
        sections.push(`## Scenario Data\n\n${summarizeScenarioData(input.scenarioData)}`);
    }

    sections.push(`## Rubric\n\n${input.rubric}`);

    return sections.join("\n\n");
}
