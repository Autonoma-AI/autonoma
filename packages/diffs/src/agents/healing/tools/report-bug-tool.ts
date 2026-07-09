import { AgentTool } from "@autonoma/ai";
import { Screenshot } from "@autonoma/image";
import { getStepOverlayPoints, type IssueReport, type PrimaryScreenshot, type ScreenshotPin } from "@autonoma/types";
import type { z } from "zod";
import { reportBugInputSchema } from "../../../healing/actions";
import type { RenderableReviewStep } from "../../../review/kernel";
import type { ScreenshotLoader } from "../../tools/screenshot/screenshot-types";
import type { HealingAgentLoop } from "../healing-agent-loop";
import { recordHealingAction, resolveReviewLink } from "./record-action";

export type HealingReportBugInput = z.infer<typeof reportBugInputSchema>;

interface ReportBugOutput {
    testCaseId: string;
}

/** Action tool: report a confirmed application bug; files the Issue + Bug while the test keeps running. */
export class HealingReportBugTool extends AgentTool<HealingReportBugInput, ReportBugOutput, HealingAgentLoop> {
    constructor() {
        super({
            name: "report_bug",
            description:
                "Report a confirmed application bug. Atomic: creates an Issue and links to an existing Bug or creates a new one. The test stays in the suite and keeps running every snapshot - you are recording why it currently fails, not excluding it, so a later fix is observed when it passes again. The apply layer dedupes against existing bugs and against your other report_bug calls in this batch - just describe each bug you find.",
            inputSchema: reportBugInputSchema,
        });
    }

    protected async execute(input: HealingReportBugInput, loop: HealingAgentLoop): Promise<ReportBugOutput> {
        const reviewLink = resolveReviewLink(loop, input.testCaseId);
        const report = await this.resolveReport(input, loop);
        recordHealingAction(loop, { kind: "report_bug", ...input, report, reviewLink });
        return { testCaseId: input.testCaseId };
    }

    /**
     * Turn the model-authored, reference-form report into the persisted shape.
     *
     * `primaryScreenshot` arrives as a step reference (the agent never sees storage
     * keys) and is resolved here against that step's real captured screenshot, so a
     * hallucinated key can never reach `Issue.report`. An unresolvable reference
     * degrades to no primary screenshot - the hero then falls back to the run's
     * failing-step frame.
     *
     * The evidence manifest is likewise derived here from what the agent actually
     * fetched for this failure, never authored - so a narrative can only surface a
     * screenshot the agent really pulled. A testCaseId with no failure key yields an
     * empty manifest (buildEvidenceManifest tolerates the undefined).
     */
    private async resolveReport(input: HealingReportBugInput, loop: HealingAgentLoop): Promise<IssueReport> {
        const primaryScreenshot = await this.resolvePrimaryScreenshot(input, loop);
        const failureKey = loop.failureKeysByTestCaseId.get(input.testCaseId);
        const evidenceManifest = loop.buildEvidenceManifest(failureKey, input.report.narrativeMarkdown);
        return {
            expectedBehavior: input.report.expectedBehavior,
            actualBehavior: input.report.actualBehavior,
            narrativeMarkdown: input.report.narrativeMarkdown,
            evidenceManifest,
            primaryScreenshot,
        };
    }

    private async resolvePrimaryScreenshot(
        input: HealingReportBugInput,
        loop: HealingAgentLoop,
    ): Promise<PrimaryScreenshot | undefined> {
        const ref = input.report.primaryScreenshot;
        if (ref == null) return undefined;

        const failureKey = loop.failureKeysByTestCaseId.get(input.testCaseId);
        const steps = failureKey != null ? loop.stepEvidenceByFailureKey.get(failureKey) : undefined;
        const step = steps?.find((s) => s.order === ref.stepOrder);
        const s3Key = ref.timing === "after" ? step?.screenshotAfterKey : step?.screenshotBeforeKey;
        if (step == null || s3Key == null) {
            this.logger.warn(
                "Dropping unresolvable primaryScreenshot reference; hero will fall back to failing-step frame",
                {
                    extra: {
                        testCaseId: input.testCaseId,
                        stepOrder: ref.stepOrder,
                        timing: ref.timing,
                        hasStep: step != null,
                    },
                },
            );
            return undefined;
        }

        // A blank / still-loading frame is worse than the failing-step fallback, so
        // never let one become the hero even if the model designates it.
        if (await this.isBlankFrame(s3Key, loop.screenshotLoader)) {
            this.logger.warn(
                "Dropping near-uniform primaryScreenshot frame; hero will fall back to failing-step frame",
                {
                    extra: { testCaseId: input.testCaseId, stepOrder: ref.stepOrder, timing: ref.timing, s3Key },
                },
            );
            return undefined;
        }

        const pin = extractPin(step);
        return pin != null ? { s3Key, pin } : { s3Key };
    }

    /**
     * Whether the designated frame is near-uniform (blank/loading). Best-effort:
     * without a loader (evals) or on a load/decode failure we cannot inspect the
     * bytes, so we keep the frame rather than drop a deliberately-chosen one.
     */
    private async isBlankFrame(s3Key: string, loader: ScreenshotLoader | undefined): Promise<boolean> {
        if (loader == null) return false;
        try {
            const buffer = await loader.loadScreenshot(s3Key);
            return await Screenshot.fromBuffer(buffer).isNearUniform();
        } catch (err) {
            this.logger.warn("Failed to inspect primaryScreenshot frame for blankness; keeping it", {
                extra: { s3Key, err },
            });
            return false;
        }
    }
}

/** The step's resolved interaction point (click/type target, or a drag's start), in screen pixels. */
function extractPin(step: RenderableReviewStep): ScreenshotPin | undefined {
    const [first] = getStepOverlayPoints(step.output);
    return first != null ? { x: first.x, y: first.y } : undefined;
}
