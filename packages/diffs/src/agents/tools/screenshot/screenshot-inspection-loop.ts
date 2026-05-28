import type { AgentLoop } from "@autonoma/ai";
import type { ReviewStepScreenshots, ScreenshotLoader } from "./screenshot-types";

/**
 * Loop that exposes the screenshot evidence for a generation or replay being reviewed. Consumed
 * by `view_step_screenshot` and `view_final_screenshot` in the reviewer agents.
 */
export interface ScreenshotInspectionLoop extends AgentLoop {
    readonly screenshotLoader: ScreenshotLoader;
    readonly steps: ReviewStepScreenshots[];
    readonly finalScreenshotKey?: string;
}
