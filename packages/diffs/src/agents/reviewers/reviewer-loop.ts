import { type AgentConfig, AgentLoop } from "@autonoma/ai";
import type { ApplicationArchitecture } from "@autonoma/db";
import type { Codebase } from "../../codebase";
import type { ScenarioData } from "../../scenario-data";
import type { CodebaseLoop } from "../tools/codebase/codebase-loop";
import type { ScenarioDataLoop } from "../tools/scenario/scenario-data-loop";
import type { ScreenshotInspectionLoop } from "../tools/screenshot/screenshot-inspection-loop";
import type { ReviewStepScreenshots, ScreenshotLoader } from "../tools/screenshot/screenshot-types";

interface ReviewerLoopParams<TResult> extends AgentConfig<TResult> {
    codebase: Codebase;
    screenshotLoader: ScreenshotLoader;
    steps: ReviewStepScreenshots[];
    finalScreenshotKey?: string;
    scenarioData?: ScenarioData;
    architecture?: ApplicationArchitecture;
}

/**
 * Per-run state for the generation and replay reviewers. Implements
 * {@link ScreenshotInspectionLoop} so the screenshot tools can resolve the
 * per-step S3 keys, {@link CodebaseLoop} so the codebase tools can read the
 * snapshot's clone, and {@link ScenarioDataLoop} so `read_scenario_entities`
 * can disclose full records from the in-memory scenario payload.
 *
 * Reviewers don't accumulate a collector - the verdict is the model's tool
 * input - so this loop is mostly a thin field carrier.
 */
export class ReviewerLoop<TResult>
    extends AgentLoop<TResult>
    implements ScreenshotInspectionLoop, CodebaseLoop, ScenarioDataLoop
{
    public readonly codebase: Codebase;
    public readonly screenshotLoader: ScreenshotLoader;
    public readonly steps: ReviewStepScreenshots[];
    public readonly finalScreenshotKey?: string;
    public readonly scenarioData?: ScenarioData;
    public readonly architecture?: ApplicationArchitecture;

    constructor({
        codebase,
        screenshotLoader,
        steps,
        finalScreenshotKey,
        scenarioData,
        architecture,
        ...config
    }: ReviewerLoopParams<TResult>) {
        super(config);
        this.codebase = codebase;
        this.screenshotLoader = screenshotLoader;
        this.steps = steps;
        this.finalScreenshotKey = finalScreenshotKey;
        this.scenarioData = scenarioData;
        this.architecture = architecture;
    }
}
