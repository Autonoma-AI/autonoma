import { AgentTool, type AgentToolModelOutput, type AgentToolModelOutputOptions, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import { buildStepSummary, type RenderableReviewStep } from "../../../review/kernel";
import type { HealingAgentLoop } from "../healing-agent-loop";

const inputSchema = z.object({
    failureKey: z
        .string()
        .describe(
            "The failure key (the `Failure key` field of the failure in the Failures list) whose step to inspect.",
        ),
    stepOrder: z
        .number()
        .int()
        .min(0)
        .describe("The step number to inspect - one of the orders listed under that failure's Execution steps."),
});

type FetchStepEvidenceInput = z.infer<typeof inputSchema>;

interface StepScreenshots {
    before?: string;
    after?: string;
}

type FetchStepEvidenceOutput =
    | { found: false; failureKey: string; stepOrder: number; availableOrders: number[] }
    | { found: true; failureKey: string; stepOrder: number; summary: string; screenshots: StepScreenshots };

const DESCRIPTION =
    "Fetch the concrete evidence for one executed step of a failing test: its before/after screenshots and its full step-output text. Use it to see what the app actually looked like and did at a step the reviewer flagged, so you can ground a report_bug's Expected/Actual and narrative in what really happened rather than the plan text. Callable at any point - it can inform your decision, not just your report.";

/**
 * On-demand, per-step evidence fetch for the healing agent. The failing subjects'
 * step metadata (screenshot S3 keys + output text) is gathered by the loader and
 * carried on the loop, keyed by failure key; this tool resolves one step's
 * screenshot bytes lazily via the loop's screenshot loader and returns them
 * alongside the rendered step-output text. It is never eager - the reviewer's
 * media-digestion optimization is preserved; healing reads the reviewers' verdicts
 * to know which steps are worth inspecting, then pulls exactly those.
 *
 * Overrides {@link AgentTool.toModelOutput} so the screenshot bytes reach the
 * model as inline media without bypassing the base execution/error wrapper.
 * Degrades gracefully: with no screenshot loader (e.g. evals) or no screenshots
 * captured for the step, it returns the step-output text alone.
 */
export class FetchStepEvidenceTool extends AgentTool<
    FetchStepEvidenceInput,
    FetchStepEvidenceOutput,
    HealingAgentLoop
> {
    constructor() {
        super({
            name: "fetch_step_evidence",
            description: DESCRIPTION,
            inputSchema,
        });
    }

    protected async execute(
        { failureKey, stepOrder }: FetchStepEvidenceInput,
        loop: HealingAgentLoop,
    ): Promise<FetchStepEvidenceOutput> {
        const steps = loop.stepEvidenceByFailureKey.get(failureKey);
        if (steps == null) {
            const known = [...loop.stepEvidenceByFailureKey.keys()];
            const hint =
                known.length > 0
                    ? `Use one of the failure keys with recorded steps: ${known.join(", ")}.`
                    : "No failure in this batch has recorded steps to inspect.";
            throw new FixableToolError(`No step evidence for failure key "${failureKey}". ${hint}`);
        }

        const step = steps.find((s) => s.order === stepOrder);
        if (step == null) {
            return { found: false, failureKey, stepOrder, availableOrders: steps.map((s) => s.order) };
        }

        const summary = buildStepSummary([step]);
        const screenshots = await this.loadScreenshots(step, loop);
        return { found: true, failureKey, stepOrder, summary, screenshots };
    }

    /**
     * Rehydrate the step's before/after screenshot bytes as base64, when both a
     * key and a loader are present. A load failure is swallowed to a text-only
     * result rather than failing the whole call - the step-output text is still
     * useful, and a missing screenshot must never block a report.
     */
    private async loadScreenshots(step: RenderableReviewStep, loop: HealingAgentLoop): Promise<StepScreenshots> {
        if (loop.screenshotLoader == null) return {};
        const loader = loop.screenshotLoader;

        const [before, after] = await Promise.all([
            this.tryLoad(loader, step.screenshotBeforeKey),
            this.tryLoad(loader, step.screenshotAfterKey),
        ]);
        return { before, after };
    }

    private async tryLoad(
        loader: NonNullable<HealingAgentLoop["screenshotLoader"]>,
        key: string | undefined,
    ): Promise<string | undefined> {
        if (key == null) return undefined;
        try {
            const buffer = await loader.loadScreenshot(key);
            return buffer.toString("base64");
        } catch (err) {
            this.logger.warn("Failed to load step screenshot; returning step-output text only", {
                extra: { key, err },
            });
            return undefined;
        }
    }

    protected override toModelOutput({
        output,
    }: AgentToolModelOutputOptions<FetchStepEvidenceInput, FetchStepEvidenceOutput>): AgentToolModelOutput<
        FetchStepEvidenceInput,
        FetchStepEvidenceOutput
    > {
        if (!output.success) return { type: "error-json", value: toErrorJson(output) };

        const out = output.result;
        if (!out.found) {
            const orders = out.availableOrders.length > 0 ? out.availableOrders.join(", ") : "none";
            return {
                type: "text",
                value: `No step ${out.stepOrder} for failure ${out.failureKey}. Available step orders: ${orders}.`,
            };
        }

        const value: Array<{ type: "text"; text: string } | { type: "media"; data: string; mediaType: string }> = [
            { type: "text", text: `Evidence for step ${out.stepOrder} (failure ${out.failureKey}):\n${out.summary}` },
        ];
        if (out.screenshots.before != null) {
            value.push({ type: "text", text: `Before step ${out.stepOrder}:` });
            value.push({ type: "media", data: out.screenshots.before, mediaType: "image/png" });
        }
        if (out.screenshots.after != null) {
            value.push({ type: "text", text: `After step ${out.stepOrder}:` });
            value.push({ type: "media", data: out.screenshots.after, mediaType: "image/png" });
        }
        return { type: "content", value };
    }
}

function toErrorJson(output: { error: string; fixSuggestion?: string }) {
    return output.fixSuggestion == null
        ? { success: false, error: output.error }
        : { success: false, error: output.error, fixSuggestion: output.fixSuggestion };
}
