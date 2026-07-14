import { type ScreenResolution, type Screenshot, getScreenshotConfig } from "@autonoma/image";

/**
 * Determines the resolution to use for a visual grounding task.
 *
 * The rules are the following:
 * - If a target resolution is provided, it is used.
 * - If no target resolution is provided, the device resolution is used, if configured.
 * - If no device resolution is configured, the image resolution is used.
 */
export async function resolveResolution(
    image: Screenshot,
    targetResolution?: ScreenResolution,
): Promise<ScreenResolution> {
    if (targetResolution != null) return targetResolution;

    const { screenResolution } = getScreenshotConfig();
    if (screenResolution != null) return screenResolution;

    return image.getResolution();
}
