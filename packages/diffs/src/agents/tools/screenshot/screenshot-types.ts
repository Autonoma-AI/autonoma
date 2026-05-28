/**
 * Loader for a single screenshot blob. The reviewer's evidence loader supplies
 * the bytes for an S3 key (or another addressing scheme).
 */
export interface ScreenshotLoader {
    loadScreenshot(key: string): Promise<Buffer>;
}

/**
 * The screenshot keys captured for a single step of an execution being reviewed.
 * Some steps don't have before/after screenshots, hence both fields are optional.
 */
export interface ReviewStepScreenshots {
    order: number;
    screenshotBeforeKey?: string;
    screenshotAfterKey?: string;
}
