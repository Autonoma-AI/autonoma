import { AgentTool, type AgentToolModelOutput, type AgentToolModelOutputOptions } from "@autonoma/ai";
import { Screenshot } from "@autonoma/image";
import type { OverlayPoint } from "@autonoma/types";
import { z } from "zod";
import type { ScreenshotInspectionLoop } from "./screenshot-inspection-loop";

const viewStepScreenshotInputSchema = z.object({
    stepOrder: z.number().int().min(0).describe("The step number to view (0-indexed)"),
    timing: z.enum(["before", "after"]).describe("Whether to view the screenshot before or after the step executed"),
});

type ViewStepScreenshotInput = z.infer<typeof viewStepScreenshotInputSchema>;

type ViewStepScreenshotOutput =
    | { found: false; stepOrder: number; timing: "before" | "after" }
    | { found: true; stepOrder: number; timing: "before" | "after"; base64: string; annotated: boolean };

const DESCRIPTION =
    "View the screenshot taken before or after a specific step. Use this to visually inspect what the application looked like at a particular point during execution.";

const ANNOTATION_LABEL =
    "The marker shows the engine's resolved click location (where it targeted on this screenshot) - use it to judge whether the engine clicked the right element.";

/**
 * View the screenshot taken before or after a specific step. Overrides
 * {@link AgentTool.toModelOutput} so the image bytes can be returned to the
 * model as inline media without bypassing the base execution/error wrapper.
 * The before screenshot is annotated with the engine's resolved click point so
 * the reviewer can see where the click landed.
 */
export class ViewStepScreenshotTool extends AgentTool<
    ViewStepScreenshotInput,
    ViewStepScreenshotOutput,
    ScreenshotInspectionLoop
> {
    constructor() {
        super({
            name: "view_step_screenshot",
            description: DESCRIPTION,
            inputSchema: viewStepScreenshotInputSchema,
        });
    }

    protected async execute(
        { stepOrder, timing }: ViewStepScreenshotInput,
        loop: ScreenshotInspectionLoop,
    ): Promise<ViewStepScreenshotOutput> {
        const step = loop.steps.find((s) => s.order === stepOrder);
        if (step == null) return { found: false, stepOrder, timing };

        const key = timing === "before" ? step.screenshotBeforeKey : step.screenshotAfterKey;
        if (key == null) return { found: false, stepOrder, timing };

        const buffer = await loop.screenshotLoader.loadScreenshot(key);

        const points = step.overlayPoints ?? [];
        // Before-only (the state that was clicked), and WEB only: web points are already
        // in image space so they draw as-is, whereas mobile points are in device space and
        // would be mis-placed without `screenResolution` scaling that isn't threaded here -
        // the seam to extend for mobile is `drawResolvedPoints` below.
        const shouldAnnotate = timing === "before" && loop.architecture === "WEB" && points.length > 0;
        if (!shouldAnnotate) {
            return { found: true, stepOrder, timing, base64: buffer.toString("base64"), annotated: false };
        }

        const annotated = await drawResolvedPoints(buffer, points);
        return { found: true, stepOrder, timing, base64: annotated.toString("base64"), annotated: true };
    }

    protected override toModelOutput({
        output,
    }: AgentToolModelOutputOptions<ViewStepScreenshotInput, ViewStepScreenshotOutput>): AgentToolModelOutput<
        ViewStepScreenshotInput,
        ViewStepScreenshotOutput
    > {
        if (!output.success) return { type: "error-json", value: toErrorJson(output) };

        const out = output.result;
        if (!out.found) {
            return { type: "text", value: `No ${out.timing} screenshot available for step ${out.stepOrder}` };
        }
        const caption = out.annotated
            ? `Screenshot for step ${out.stepOrder} (${out.timing}). ${ANNOTATION_LABEL}`
            : `Screenshot for step ${out.stepOrder} (${out.timing}):`;
        return {
            type: "content",
            value: [
                { type: "text", text: caption },
                { type: "media", data: out.base64, mediaType: "image/png" },
            ],
        };
    }
}

/** Draw a click circle for a click/type target, or a start/end/line annotation for a drag. */
async function drawResolvedPoints(buffer: Buffer, points: OverlayPoint[]): Promise<Buffer> {
    const click = points.find((p) => p.role === "click");
    const start = points.find((p) => p.role === "drag-start");
    const end = points.find((p) => p.role === "drag-end");

    let screenshot = Screenshot.fromBuffer(buffer);
    if (click != null) screenshot = await screenshot.drawClickCircle(click);
    if (start != null && end != null) screenshot = await screenshot.drawDragAnnotation(start, end);
    return screenshot.buffer;
}

function toErrorJson(output: { error: string; fixSuggestion?: string }) {
    return output.fixSuggestion == null
        ? { success: false, error: output.error }
        : { success: false, error: output.error, fixSuggestion: output.fixSuggestion };
}
