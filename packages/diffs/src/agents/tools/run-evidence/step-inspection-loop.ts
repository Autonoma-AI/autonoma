import type { AgentLoop } from "@autonoma/ai";
import type { ApplicationArchitecture } from "@autonoma/db";
import type { InspectableStep, ScreenshotLoader } from "./run-evidence-types";

/** Loop that exposes a run's per-step evidence. Consumed by `view_step_details`. */
export interface StepInspectionLoop extends AgentLoop {
    readonly screenshotLoader: ScreenshotLoader;
    readonly steps: InspectableStep[];
    /** Gates before-screenshot point annotation to WEB (see `view_step_details`). */
    readonly architecture?: ApplicationArchitecture;
}
