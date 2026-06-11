import { describe, expect, it } from "vitest";
import { type RenderableReviewStep, buildStepSummary } from "../src/review/kernel";

describe("buildStepSummary", () => {
    it("reports when no steps were executed", () => {
        expect(buildStepSummary([])).toBe("No steps were executed.");
    });

    it("renders an assert step's per-assertion results - the false-positive-success signal", () => {
        const steps: RenderableReviewStep[] = [
            {
                order: 1,
                interaction: "assert",
                params: { instruction: "the cart shows 2 items and the total is $20" },
                status: "success",
                output: {
                    outcome: "success",
                    results: [
                        { assertion: "the cart shows 2 items", metCondition: true, reason: "two rows rendered" },
                        { assertion: "the total is $20", metCondition: false, reason: "total reads $18" },
                    ],
                },
            },
        ];

        const summary = buildStepSummary(steps);

        expect(summary).toContain("### Step 1: assert");
        expect(summary).toContain("**Outcome**: success");
        // Each assertion surfaces individually, including the one that did NOT hold
        // despite the overall step reporting success.
        expect(summary).toContain("the cart shows 2 items - met: true");
        expect(summary).toContain("the total is $20 - met: false (total reads $18)");
    });

    it("renders the resolved point for a click step", () => {
        const summary = buildStepSummary([
            {
                order: 2,
                interaction: "click",
                params: { description: "the Confirm button" },
                status: "success",
                output: { outcome: "success", point: { x: 120, y: 48 } },
            },
        ]);

        expect(summary).toContain('**Resolved point**: {"x":120,"y":48}');
    });

    it("renders conditionMet and reasoning for a wait-until step", () => {
        const summary = buildStepSummary([
            {
                order: 3,
                interaction: "wait-until",
                params: { condition: "the spinner disappears", timeout: 5000 },
                status: "success",
                output: { outcome: "timeout", conditionMet: false, reasoning: "the spinner was still visible" },
            },
        ]);

        expect(summary).toContain("**Condition met**: false");
        expect(summary).toContain("**Reasoning**: the spinner was still visible");
    });

    it("renders errorName and message on failure, framed by the classifier-not-verdict guard", () => {
        const summary = buildStepSummary([
            {
                order: 1,
                interaction: "click",
                params: { description: "the Submit button" },
                status: "failed",
                error: "could not find element matching 'the Submit button'",
                errorName: "ElementNotFoundError",
            },
        ]);

        // The one-line guard is present because there is at least one failure.
        expect(summary).toContain("error type is a classifier, not a verdict");
        expect(summary).toContain("**Status**: failed");
        expect(summary).toContain("**Error type**: `ElementNotFoundError`");
        expect(summary).toContain("**Error message**: could not find element matching 'the Submit button'");
    });

    it("omits the classifier guard entirely when every step succeeded", () => {
        const summary = buildStepSummary([
            {
                order: 1,
                interaction: "navigate",
                params: { url: "/login" },
                status: "success",
                output: { outcome: "success", url: "https://app.test/login" },
            },
        ]);

        expect(summary).not.toContain("classifier, not a verdict");
        expect(summary).toContain("**URL**: https://app.test/login");
    });

    it("advertises the screenshot tool only when a step carries screenshots", () => {
        const summary = buildStepSummary([
            {
                order: 1,
                interaction: "type",
                params: { description: "email", text: "a@b.test" },
                status: "success",
                output: { outcome: "success" },
                screenshotBeforeKey: "generation/g/attempt-1-before.jpeg",
            },
            {
                order: 2,
                interaction: "refresh",
                params: {},
                status: "success",
                output: { outcome: "success", url: "https://app.test" },
            },
        ]);

        const [first, second] = summary.split("\n\n");
        expect(first).toContain("view_step_screenshot");
        expect(second).not.toContain("view_step_screenshot");
    });

    it("falls back to the raw structured output for commands without a curated projection", () => {
        const summary = buildStepSummary([
            {
                order: 1,
                interaction: "some-future-command",
                params: {},
                status: "success",
                output: { outcome: "success", customField: 42 },
            },
        ]);

        expect(summary).toContain('**Output**: {"outcome":"success","customField":42}');
    });
});
