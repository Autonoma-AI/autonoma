import type { ApplicationArchitecture } from "@autonoma/db";
import type { OverlayPoint } from "@autonoma/types";
import type { ModelMessage } from "ai";
import type { ScenarioData } from "../../scenario-data";
import type { ChangeContext, IterationLineage, ReviewStep } from "../kernel";

/**
 * One reviewed generation step, sourced from the `StepAttempt` timeline (every
 * attempt, successes and failures, in true order). It is the normalized
 * {@link ReviewStep} plus the presentation metadata the summary and screenshot
 * tool need: the attempt-timeline `order` and the before/after screenshot keys.
 */
export interface GenerationStepData extends ReviewStep {
    order: number;
    screenshotBeforeKey?: string;
    screenshotAfterKey?: string;
    /** The engine's resolved click/drag point(s), extracted from `output` for screenshot annotation. */
    overlayPoints?: OverlayPoint[];
}

/**
 * Everything the GenerationReviewer needs to render a prompt and run the
 * agent. Loaded once by the `DiffJobContextLoader`, then passed around as a
 * read-only value object.
 */
export interface GenerationContext {
    generationId: string;
    organizationId: string;
    /** What the execution agent self-reported. The reviewer's verdict overrides this. */
    selfReportedStatus: "success" | "failed" | "running" | "queued" | "pending";
    /** The test case's name - the loop-stable label the diff system never rewrites. */
    testCaseName: string;
    /**
     * The test case's description - the loop-stable statement of intent (unlike the
     * plan prompt, which the diff system rewrites during healing). Meant to be set on
     * every test case; missing only on older cases not yet backfilled. Anchors the
     * `scenario_unsupported` verdict - without it the reviewer can't reliably tell a
     * true data gap from a worded-wrong plan, so it conservatively falls back to
     * `plan_mismatch`.
     */
    testCaseDescription?: string;
    testPlanPrompt: string;
    conversation: ModelMessage[];
    reasoning?: string;
    videoUrl?: string;
    /** Dead-time-stripped mp4 (S3 key). Preferred over `videoUrl` for the video model - fewer billed frames. */
    optimizedVideoUrl?: string;
    finalScreenshotKey?: string;
    steps: GenerationStepData[];
    /** Gates before-screenshot point annotation to WEB. */
    architecture?: ApplicationArchitecture;
    /**
     * DB-sourced facts about the code change under review. Absent for a SHA-less
     * snapshot; the generation reviewer asserts its presence (every reviewed
     * generation executes against a checked-out head SHA).
     */
    change?: ChangeContext;
    /**
     * Point-in-time refinement-loop history for this test, one entry per iteration
     * (the plan it scoped and the verdicts it reached), oldest first. Empty for
     * first-iteration reviews and for tests outside a refinement loop.
     */
    lineage: IterationLineage[];
    /**
     * Materialized snapshot of the data the generation's scenario actually
     * created. Omitted when the generation has no scenario instance, UP never
     * succeeded, or the generated-data graph is empty (e.g. historical instances
     * predating #815). A bounded summary is inlined into the prompt; full records
     * are surfaced on demand via the `read_scenario_entities` tool. Lets the
     * reviewer catch plans that reference data the scenario never created - a
     * strong `plan_mismatch` signal.
     */
    scenario?: ScenarioData;
}
