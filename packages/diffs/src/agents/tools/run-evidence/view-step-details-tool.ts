import {
    AgentTool,
    type AgentToolModelOutput,
    type AgentToolModelOutputOptions,
    type ToolContentItem,
    imageToolContent,
} from "@autonoma/ai";
import type { Screenshot } from "@autonoma/image";
import type { OverlayPoint } from "@autonoma/types";
import { z } from "zod";
import type { InspectableStep } from "./run-evidence-types";
import type { StepInspectionLoop } from "./step-inspection-loop";

/** How many step numbers to spell out when telling the model which steps it can actually ask for. */
const MAX_LISTED_STEPS = 30;

const viewStepDetailsInputSchema = z.object({
    stepOrder: z
        .number()
        .int()
        .min(0)
        // Matched against the step's own `order` - the number every caller renders to the model ("### Step N",
        // "N. [interaction] status"), NOT a position in the step array, which would mis-resolve whenever the
        // orders are not a contiguous 1..N (a retried or partially-recorded run).
        .describe("The step number to inspect, as shown in the step listing"),
});

type ViewStepDetailsInput = z.infer<typeof viewStepDetailsInputSchema>;

interface StepFrame {
    timing: "before" | "after";
    base64: string;
    mediaType: string;
    annotated: boolean;
}

type ViewStepDetailsOutput =
    | { found: false; stepOrder: number; availableSteps: number[] }
    | { found: true; stepOrder: number; summary: string; frames: StepFrame[] };

const DESCRIPTION =
    "Inspect one step in full: BOTH of its screenshots (before and after) plus everything the engine recorded about it - the interaction, its parameters (the described element, the assertion text, the typed value), its structured output (for an assert, each individual assertion and whether it held), and any error. Nothing is truncated. Use this on the steps that matter to see exactly what the agent did and what the app showed either side of it.";

const ANNOTATION_LABEL =
    "The marker shows the engine's resolved click location (where it targeted on this screenshot) - use it to judge whether the engine clicked the right element.";

/**
 * Disclose one step of a run in full - both frames as PIXELS, and the engine's own record of the step,
 * uncapped.
 *
 * The prompt's step trace is the INDEX: one capped line per step so the whole run fits. This is the
 * drill-down, so it truncates nothing - a step the model bothered to ask about is one whose assertion text or
 * error payload is worth reading whole. Frames go back as inline media rather than a description, because the
 * reasoning model reads an image better than it reads a second model's prose about one.
 *
 * Both frames, not a chosen one: the question that needs a step's frame is almost always "what changed",
 * which one side cannot answer. Only the before-frame is annotated - it is the state the click was resolved
 * against, so it is the only one where the marker means anything.
 */
export class ViewStepDetailsTool extends AgentTool<ViewStepDetailsInput, ViewStepDetailsOutput, StepInspectionLoop> {
    constructor() {
        super({
            name: "view_step_details",
            description: DESCRIPTION,
            inputSchema: viewStepDetailsInputSchema,
        });
    }

    protected async execute(
        { stepOrder }: ViewStepDetailsInput,
        loop: StepInspectionLoop,
    ): Promise<ViewStepDetailsOutput> {
        // A miss is a real result, not a failure: the model asked for a step that was never recorded, and what
        // it needs back is which steps it CAN ask for - so it retries against reality instead of guessing again.
        const step = loop.steps.find((candidate) => candidate.order === stepOrder);
        if (step == null) {
            return { found: false, stepOrder, availableSteps: loop.steps.map((candidate) => candidate.order) };
        }

        const frames = await this.loadFrames(step, loop);
        return { found: true, stepOrder, summary: describeStep(step), frames };
    }

    /** Both captured frames, in the order they happened, annotated where the marker is meaningful. */
    private async loadFrames(step: InspectableStep, loop: StepInspectionLoop): Promise<StepFrame[]> {
        // Both fetches start together: only the before-frame's annotation depends on a load, and this runs
        // inside an agent step, so a serialized second download sits on the model's critical path.
        const [loadedBefore, after] = await Promise.all([
            step.screenshotBeforeKey != null
                ? loop.screenshotLoader.loadScreenshot(step.screenshotBeforeKey)
                : undefined,
            step.screenshotAfterKey != null ? loop.screenshotLoader.loadScreenshot(step.screenshotAfterKey) : undefined,
        ]);

        const frames: StepFrame[] = [];

        if (loadedBefore != null) {
            const points = step.overlayPoints ?? [];
            // WEB only: web points are already in image space so they draw as-is, whereas mobile points are in
            // device space and would be mis-placed without `screenResolution` scaling that isn't threaded here -
            // the seam to extend for mobile is `drawResolvedPoints` below.
            const annotate = loop.architecture === "WEB" && points.length > 0;
            const screenshot = annotate ? await drawResolvedPoints(loadedBefore, points) : loadedBefore;
            frames.push({
                timing: "before",
                base64: screenshot.base64,
                mediaType: screenshot.mediaType,
                annotated: annotate,
            });
        }

        if (after != null) {
            frames.push({
                timing: "after",
                base64: after.base64,
                mediaType: after.mediaType,
                annotated: false,
            });
        }

        return frames;
    }

    protected override toModelOutput({
        output,
    }: AgentToolModelOutputOptions<ViewStepDetailsInput, ViewStepDetailsOutput>): AgentToolModelOutput<
        ViewStepDetailsInput,
        ViewStepDetailsOutput
    > {
        if (!output.success) return { type: "error-json", value: toErrorJson(output) };

        const out = output.result;
        if (!out.found) {
            return { type: "text", value: describeMiss(out.stepOrder, out.availableSteps) };
        }

        const value: ToolContentItem[] = [{ type: "text", text: `Step ${out.stepOrder}:\n${out.summary}` }];
        for (const frame of out.frames) {
            const caption = frame.annotated
                ? `Screenshot ${frame.timing} step ${out.stepOrder}. ${ANNOTATION_LABEL}`
                : `Screenshot ${frame.timing} step ${out.stepOrder}:`;
            value.push({ type: "text", text: caption });
            value.push(imageToolContent(frame));
        }
        if (out.frames.length === 0) {
            value.push({ type: "text", text: "No screenshot was captured either side of this step." });
        }
        return { type: "content", value };
    }
}

/** The engine's record of the step, rendered whole - this is the drill-down, so nothing is elided. */
function describeStep(step: InspectableStep): string {
    const lines: string[] = [];
    if (step.interaction != null) lines.push(`interaction: ${step.interaction}`);
    if (step.status != null) lines.push(`status: ${step.status}`);
    if (step.params != null) lines.push(`params: ${JSON.stringify(step.params, undefined, 2)}`);
    if (step.output != null) lines.push(`output: ${JSON.stringify(step.output, undefined, 2)}`);
    if (step.errorName != null) lines.push(`errorName: ${step.errorName}`);
    if (step.error != null) lines.push(`error: ${step.error}`);
    return lines.length > 0 ? lines.join("\n") : "(the engine recorded no detail for this step)";
}

function describeMiss(stepOrder: number, availableSteps: number[]): string {
    const missing = `There is no step ${stepOrder} in this run.`;
    if (availableSteps.length === 0) return `${missing} No steps were recorded at all.`;

    const listed = availableSteps.slice(0, MAX_LISTED_STEPS).join(", ");
    const elided = availableSteps.length > MAX_LISTED_STEPS ? ", ..." : "";
    return `${missing} Steps you can inspect: ${listed}${elided}.`;
}

/** Draw a click circle for a click/type target, or a start/end/line annotation for a drag. */
async function drawResolvedPoints(screenshot: Screenshot, points: OverlayPoint[]): Promise<Screenshot> {
    const click = points.find((p) => p.role === "click");
    const start = points.find((p) => p.role === "drag-start");
    const end = points.find((p) => p.role === "drag-end");

    let annotated = screenshot;
    if (click != null) annotated = await annotated.drawClickCircle(click);
    if (start != null && end != null) annotated = await annotated.drawDragAnnotation(start, end);
    return annotated;
}

function toErrorJson(output: { error: string; fixSuggestion?: string }) {
    return output.fixSuggestion == null
        ? { success: false, error: output.error }
        : { success: false, error: output.error, fixSuggestion: output.fixSuggestion };
}
