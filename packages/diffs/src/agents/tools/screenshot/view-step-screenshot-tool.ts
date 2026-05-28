import { AgentTool, type AgentToolModelOutput, type AgentToolModelOutputOptions } from "@autonoma/ai";
import { z } from "zod";
import type { ScreenshotInspectionLoop } from "./screenshot-inspection-loop";

const viewStepScreenshotInputSchema = z.object({
    stepOrder: z.number().int().min(0).describe("The step number to view (0-indexed)"),
    timing: z.enum(["before", "after"]).describe("Whether to view the screenshot before or after the step executed"),
});

type ViewStepScreenshotInput = z.infer<typeof viewStepScreenshotInputSchema>;

type ViewStepScreenshotOutput =
    | { found: false; stepOrder: number; timing: "before" | "after" }
    | { found: true; stepOrder: number; timing: "before" | "after"; base64: string };

const DESCRIPTION =
    "View the screenshot taken before or after a specific step. Use this to visually inspect what the application looked like at a particular point during execution.";

/**
 * View the screenshot taken before or after a specific step. Overrides
 * {@link AgentTool.toModelOutput} so the image bytes can be returned to the
 * model as inline media without bypassing the base execution/error wrapper.
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
        const key = timing === "before" ? step?.screenshotBeforeKey : step?.screenshotAfterKey;
        if (key == null) return { found: false, stepOrder, timing };

        const buffer = await loop.screenshotLoader.loadScreenshot(key);
        return { found: true, stepOrder, timing, base64: buffer.toString("base64") };
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
        return {
            type: "content",
            value: [
                { type: "text", text: `Screenshot for step ${out.stepOrder} (${out.timing}):` },
                { type: "media", data: out.base64, mediaType: "image/png" },
            ],
        };
    }
}

function toErrorJson(output: { error: string; fixSuggestion?: string }) {
    return output.fixSuggestion == null
        ? { success: false, error: output.error }
        : { success: false, error: output.error, fixSuggestion: output.fixSuggestion };
}
