import { Agent, TextGenerator, type LanguageModel, type ModelMessage, type RetryConfig } from "@autonoma/ai";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { sharedCompactor } from "../../agents/compaction";
import { buildCodebaseTools } from "../../agents/tools/codebase/build-codebase-tools";
import { ViewStepDetailsTool } from "../../agents/tools/run-evidence/view-step-details-tool";
import { buildRepoManifestSection } from "../../codebase";
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
 * `buildRetry` treats a TIMEOUT as transient, so `maxRetries` multiplies the per-attempt ceiling
 * ({@link RECORDING_TIMEOUT_MS}): this caps a slow read at 3 attempts, ~12 minutes total, well inside the
 * 30-minute Temporal `startToCloseTimeout` that is this classifier's only wall clock. The shared default
 * (11 attempts) would let one hung read run that clock out several times over.
 */
const VISION_RETRY: RetryConfig = { maxRetries: 2, initialDelayInMs: 1000, backoffFactor: 2, maxDelayInMs: 10_000 };

/**
 * Ceiling for one full-recording read, which re-sends the whole video. Reads run from ~10s to a few minutes on
 * a slow upstream, so the bound is set to give a genuinely-working read room to finish: a timed-out read is
 * retried as transient (see {@link VISION_RETRY}), so a bound set too tight turns a slow-but-valid read into a
 * chain of timeouts that exhausts the retry budget and drops the scan entirely.
 */
const RECORDING_TIMEOUT_MS = 4 * 60_000;

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
                runKind: input.target.kind,
                test: input.test.slug,
                success: input.run.success,
                finishReason: input.run.finishReason,
            },
        });

        // Deterministic probes FIRST - surface on-screen errors + plan divergence + whether the test's
        // intended OUTCOMES occurred, as fact before the classifier reasons, so none can be missed in
        // favour of a hypothesis.
        const recording = input.run.recording;
        const scans =
            recording != null
                ? await runVisionProbes({ recording, reader: this.recordingReader, testPlan: input.test.plan })
                : undefined;
        let promptText = buildClassifierPrompt({
            input,
            scans,
            evidenceLimits: describeEvidenceLimits(input),
        });

        // When the snapshot deployed a multi-repo preview, tell the classifier which dependency repos are checked
        // out beside the primary and how to diff each - a backend defect grounds against a dependency repo just
        // like one in the primary.
        const manifest = input.codebase.dependencyManifest();
        if (manifest != null) {
            promptText += `\n\n## Repositories\n\n${await buildRepoManifestSection(manifest)}`;
        }

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
        //
        // The two preview tools are gated INDEPENDENTLY: listing env-var names needs only a name list, so a
        // caller may hold that while having no way to reach the running pod.
        const previewScript = input.previewScript;
        const scriptTools = previewScript != null ? [new RunScriptTool(previewScript)] : [];
        const previewEnv = input.previewEnv;
        const envTools = previewEnv != null ? [new PreviewEnvTool(previewEnv)] : [];
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
                ...scriptTools,
                ...envTools,
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
