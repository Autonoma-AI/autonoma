import { Agent, TextGenerator, type LanguageModel, type ModelMessage, type RetryConfig } from "@autonoma/ai";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { sharedCompactor } from "../../agents/compaction";
import { buildCodebaseTools } from "../../agents/tools/codebase/build-codebase-tools";
import { ViewStepDetailsTool } from "../../agents/tools/run-evidence/view-step-details-tool";
import type { RunVerdict } from "../schema";
import { ClassifierAgentLoop } from "./classifier-agent-loop";
import { describeEvidenceLimits } from "./evidence-limits";
import { runVisionProbes } from "./probes";
import { CLASSIFIER_SYSTEM_PROMPT, buildClassifierPrompt } from "./prompt";
import { AnalyzeVideoTool } from "./tools/analyze-video-tool";
import { AppLogsTool } from "./tools/app-logs-tool";
import { PreviewEnvTool } from "./tools/preview-env-tool";
import { PriorRunsTool } from "./tools/prior-runs-tool";
import { RunScriptTool } from "./tools/run-script-tool";
import type { ClassifierInput } from "./types";
import { VerdictTool } from "./verdict-tool";

/**
 * Bounded retry for the vision reads, tighter than the shared default.
 *
 * `buildRetry` treats a TIMEOUT as transient, so `maxRetries` multiplies the per-attempt ceiling: the default
 * policy would let one hung full-recording read spend 33 minutes, past the 30-minute Temporal
 * `startToCloseTimeout` that is this classifier's only wall clock.
 */
const VISION_RETRY: RetryConfig = { maxRetries: 3, initialDelayInMs: 1000, backoffFactor: 2, maxDelayInMs: 10_000 };

/** A full-recording read re-sends the whole video and has been measured from ~10s to well over a minute. */
const RECORDING_TIMEOUT_MS = 3 * 60_000;
export interface ClassifierAgentConfig {
    /** The reasoning model that drives the loop. */
    model: LanguageModel;
    /**
     * The model behind the deterministic probes and `analyze_video` - the only vision reader the classifier
     * has. Frames reach the reasoning model as PIXELS (the attached final screenshot, `view_step_details`),
     * never as a second model's prose about an image this one can already see.
     */
    videoModel: LanguageModel;
}

/**
 * Determines the TRUE cause of one browser test run against a PR's preview app, and commits to a single
 * {@link RunVerdict}.
 *
 * One loop: the four deterministic vision probes run pre-loop in {@link buildUserPrompt} (in parallel, and
 * only for a run that recorded something - the model gets those four signals wrong when left to its
 * discretion, which is why they are not tools), then the model investigates and commits through `finish` with
 * every tool result still in scope - so evidence reaches the verdict without the model having to restate it.
 *
 * On exhaustion `MaxStepsReached` propagates and the Investigator workflow contains the test as a
 * coverage-plane `engine_artifact` - there is deliberately no fallback verdict path, because a guessed
 * verdict on a run nobody finished investigating is worse than an honest containment.
 */
export class ClassifierAgent extends Agent<ClassifierInput, RunVerdict, ClassifierAgentLoop> {
    private readonly logger: Logger;
    private readonly model: LanguageModel;
    private readonly recordingReader: TextGenerator;

    // Tools whose dependencies are fixed for the life of the agent live here; the ones that need a capability
    // belonging to a single run are built in createLoop, so each gets it injected rather than reaching for it.
    private readonly codebaseTools = buildCodebaseTools();
    // The shared step-viewer, not a classifier-local one: it hands the reasoning model the actual PIXELS of a
    // step's frames, where a vision-question tool would interpose a second model's prose description of images
    // this model can read itself. It returns the before AND after frame, each labelled, so the settled state is
    // never confused with the one that was acted on - the distinction the timing-race check depends on.
    private readonly viewStepDetailsTool = new ViewStepDetailsTool();
    private readonly verdictTool = new VerdictTool();

    constructor({ model, videoModel }: ClassifierAgentConfig) {
        super();
        this.model = model;
        // The recording read is bound here to its model and its own time budget, rather than passed as a bare
        // model for a call site to combine: a read is an object you ask a question of, so which model answers is
        // fixed by which reader you hold.
        this.recordingReader = new TextGenerator({
            model: videoModel,
            timeoutMs: RECORDING_TIMEOUT_MS,
            retry: VISION_RETRY,
        });
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    protected async buildUserPrompt(input: ClassifierInput): Promise<ModelMessage[]> {
        this.logger.info("Classifying run outcome", {
            extra: {
                appSlug: input.appSlug,
                prNumber: input.prNumber,
                test: input.test.slug,
                success: input.run.success,
                finishReason: input.run.finishReason,
            },
        });

        // Deterministic probes FIRST - surface on-screen errors + plan divergence + whether the test's
        // intended OUTCOMES occurred, as fact before the classifier reasons, so none can be missed in
        // favour of a hypothesis. `buildUserPrompt` is async precisely for this pre-loop work.
        //
        // Skipped outright when the run recorded nothing: every probe asks what happened ACROSS the run, which
        // no other artifact answers, so the prompt says so plainly instead of rendering four empty scans.
        const recording = input.run.recording;
        const scans =
            recording != null
                ? await runVisionProbes({ recording, reader: this.recordingReader, testPlan: input.test.plan })
                : undefined;
        const promptText = buildClassifierPrompt({
            input,
            scans,
            evidenceLimits: describeEvidenceLimits(input),
        });

        const finalScreenshot = input.run.finalScreenshot;
        if (finalScreenshot == null) return [{ role: "user", content: promptText }];
        return [
            {
                role: "user",
                content: [
                    { type: "text", text: promptText },
                    { type: "image", image: finalScreenshot },
                ],
            },
        ];
    }

    protected async createLoop(input: ClassifierInput): Promise<ClassifierAgentLoop> {
        // Each of these takes its capability in its constructor, so inside the tool it is not optional and there
        // is no absent-capability branch to write. Building them here is what makes that true: a capability this
        // run does not have produces no tool at all, rather than a registered tool that has to explain itself.
        // describeEvidenceLimits then tells the model what the gap means for its verdict - the one thing an
        // empty toolset cannot convey on its own.
        const preview = input.preview;
        const previewTools = preview != null ? [new RunScriptTool(preview), new PreviewEnvTool(preview)] : [];
        const loadAppLogs = input.loadAppLogs;
        const appLogTools = loadAppLogs != null ? [new AppLogsTool(loadAppLogs)] : [];
        // The media readers are offered only for the media this run actually produced. Roughly half of all
        // classifications have no recording, and a registered analyze_video that can only answer "there is no
        // video" is worse than its absence: the system prompt says to ALWAYS watch the recording, so the model
        // spends a step being told no by a tool instead of reading the prompt's no-recording note.
        const recording = input.run.recording;
        const videoTools = recording != null ? [new AnalyzeVideoTool(this.recordingReader, recording)] : [];

        return new ClassifierAgentLoop({
            name: "ClassifierAgent",
            model: this.model,
            systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
            tools: [
                ...this.codebaseTools,
                new PriorRunsTool(input.loadBaseline),
                ...videoTools,
                this.viewStepDetailsTool,
                ...previewTools,
                ...appLogTools,
            ],
            reportTool: this.verdictTool,
            compactor: sharedCompactor(),
            codebase: input.codebase,
            run: input.run,
            screenshotLoader: input.screenshotLoader,
        });
    }
}
