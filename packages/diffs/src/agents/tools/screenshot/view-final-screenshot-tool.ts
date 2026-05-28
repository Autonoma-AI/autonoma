import { AgentTool, type AgentToolModelOutput, type AgentToolModelOutputOptions } from "@autonoma/ai";
import { z } from "zod";
import type { ScreenshotInspectionLoop } from "./screenshot-inspection-loop";

type ViewFinalScreenshotInput = Record<string, never>;

type ViewFinalScreenshotOutput = { found: false } | { found: true; base64: string };

const DESCRIPTION =
    "View the final screenshot - what the application looked like when the last step finished executing.";

/**
 * View the final screenshot of an execution. Same multipart-output strategy as
 * {@link ViewStepScreenshotTool}: customises model output so the image bytes can be
 * inlined without bypassing {@link AgentTool}'s execution/error handling.
 */
export class ViewFinalScreenshotTool extends AgentTool<
    ViewFinalScreenshotInput,
    ViewFinalScreenshotOutput,
    ScreenshotInspectionLoop
> {
    constructor() {
        super({
            name: "view_final_screenshot",
            description: DESCRIPTION,
            inputSchema: z.object({}),
        });
    }

    protected async execute(
        _input: ViewFinalScreenshotInput,
        loop: ScreenshotInspectionLoop,
    ): Promise<ViewFinalScreenshotOutput> {
        if (loop.finalScreenshotKey == null) return { found: false };
        const buffer = await loop.screenshotLoader.loadScreenshot(loop.finalScreenshotKey);
        return { found: true, base64: buffer.toString("base64") };
    }

    protected override toModelOutput({
        output,
    }: AgentToolModelOutputOptions<ViewFinalScreenshotInput, ViewFinalScreenshotOutput>): AgentToolModelOutput<
        ViewFinalScreenshotInput,
        ViewFinalScreenshotOutput
    > {
        if (!output.success) return { type: "error-json", value: toErrorJson(output) };
        if (!output.result.found) return { type: "text", value: "No final screenshot available" };
        return {
            type: "content",
            value: [
                { type: "text", text: "Final screenshot:" },
                { type: "media", data: output.result.base64, mediaType: "image/png" },
            ],
        };
    }
}

function toErrorJson(output: { error: string; fixSuggestion?: string }) {
    return output.fixSuggestion == null
        ? { success: false, error: output.error }
        : { success: false, error: output.error, fixSuggestion: output.fixSuggestion };
}
