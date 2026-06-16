import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildReplayReviewMessages } from "../src/review/replay/message-builder";
import type { RunContext, RunStepData } from "../src/review/replay/types";

function context(steps: RunStepData[]): RunContext {
    return {
        runId: "run-1",
        organizationId: "org-1",
        testPlanPrompt: "Log in and reach the dashboard",
        testCaseName: "Login flow",
        change: { baseSha: "base000", headSha: "head111", analysisReasoning: "Login markup was rewritten." },
        lineage: [],
        steps,
    };
}

/** Concatenate every text part of the leading mixed-content user message. */
function leadingText(messages: ModelMessage[]): string {
    const content = messages[0]?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    const texts: string[] = [];
    for (const part of content) {
        if (part.type === "text") texts.push(part.text);
    }
    return texts.join("\n\n");
}

describe("buildReplayReviewMessages step summary (shared renderer reuse)", () => {
    it("reports when no steps were executed", () => {
        const text = leadingText(buildReplayReviewMessages(context([]), undefined));
        expect(text).toContain("No steps were executed.");
    });

    it("renders a failed step's errorName + message, framed by the classifier-not-verdict guard", () => {
        const text = leadingText(
            buildReplayReviewMessages(
                context([
                    {
                        order: 1,
                        interaction: "click",
                        params: { description: "the Submit button" },
                        status: "failed",
                        error: "could not find element matching 'the Submit button'",
                        errorName: "ElementNotFoundError",
                    },
                ]),
                undefined,
            ),
        );

        // The shared renderer's classifier guard fires because a step failed.
        expect(text).toContain("error type is a classifier, not a verdict");
        expect(text).toContain("### Step 1: click");
        expect(text).toContain("**Status**: failed");
        expect(text).toContain("**Error type**: `ElementNotFoundError`");
        expect(text).toContain("**Error message**: could not find element matching 'the Submit button'");
    });

    it("renders curated command output on success (assert results + navigate url), no classifier guard", () => {
        const text = leadingText(
            buildReplayReviewMessages(
                context([
                    {
                        order: 1,
                        interaction: "navigate",
                        params: { url: "/login" },
                        status: "success",
                        output: { outcome: "success", url: "https://app.test/login" },
                    },
                    {
                        order: 2,
                        interaction: "assert",
                        params: { instruction: "the cart shows 2 items and the total is $20" },
                        status: "success",
                        output: {
                            outcome: "success",
                            results: [
                                { assertion: "the cart shows 2 items", metCondition: true, reason: "two rows" },
                                { assertion: "the total is $20", metCondition: false, reason: "total reads $18" },
                            ],
                        },
                    },
                ]),
                undefined,
            ),
        );

        // Curated per-command projections come from the shared renderer.
        expect(text).toContain("**URL**: https://app.test/login");
        expect(text).toContain("the cart shows 2 items - met: true");
        expect(text).toContain("the total is $20 - met: false (total reads $18)");
        // Every step succeeded, so the failure guard is absent.
        expect(text).not.toContain("classifier, not a verdict");
        // The bespoke raw `JSON.stringify(output)` summary the renderer replaced
        // is gone for curated commands.
        expect(text).not.toContain('**Output**: {"outcome":"success","url"');
    });
});
