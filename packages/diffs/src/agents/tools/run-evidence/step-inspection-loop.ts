import type { AgentLoop } from "@autonoma/ai";
import type { ApplicationArchitecture } from "@autonoma/db";
import type { InspectableStep, ScreenshotLoader } from "./run-evidence-types";

/**
 * Loop that exposes the per-step evidence for a generation or replay being reviewed. Consumed by
 * `view_step_details` and `view_final_screenshot`.
 */
export interface StepInspectionLoop extends AgentLoop {
    readonly screenshotLoader: ScreenshotLoader;
    readonly steps: InspectableStep[];
    readonly finalScreenshotKey?: string;
    /** Gates before-screenshot point annotation to WEB (see `view_step_details`). */
    readonly architecture?: ApplicationArchitecture;
}
