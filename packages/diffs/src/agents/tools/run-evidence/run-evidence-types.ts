import type { OverlayPoint } from "@autonoma/types";

/**
 * Loader for a single screenshot blob. The reviewer's evidence loader supplies
 * the bytes for an S3 key (or another addressing scheme).
 */
export interface ScreenshotLoader {
    loadScreenshot(key: string): Promise<Buffer>;
}

/**
 * One step of an execution, as `view_step_details` discloses it.
 *
 * Everything past `order` is optional because callers differ in what they hold: the frames exist only for a
 * step that captured them, and a caller that has no structured record of the step at all still has a step
 * number worth addressing. The tool renders whichever parts are present.
 */
export interface InspectableStep {
    /** The step's own number, as every prompt renders it - never an index into the array. */
    order: number;
    screenshotBeforeKey?: string;
    screenshotAfterKey?: string;
    /** The engine's resolved click/drag point(s), drawn on the before screenshot by `view_step_details`. */
    overlayPoints?: OverlayPoint[];
    interaction?: string;
    status?: string;
    /** What the step was given - the described element, the assertion, the URL, the typed text. */
    params?: unknown;
    /** The command's structured result, including an `assert`'s per-assertion breakdown. */
    output?: unknown;
    error?: string;
    /** The thrown error's class name - an attribution classifier, not a verdict. */
    errorName?: string;
}
