import { describe, expect, it } from "vitest";
import { HealingReportBugTool } from "../src/agents/healing/tools/report-bug-tool";
import type { ScreenshotLoader } from "../src/agents/tools/screenshot/screenshot-types";
import type { HealingAction } from "../src/healing/actions";
import type { RenderableReviewStep } from "../src/review/kernel";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeHealingLoop } from "./test-loops";

const TEST_CASE_ID = "tc-failing-1";
const FAILURE_KEY = "fk-1";

// Tiny real PNGs so the near-uniform guard runs through the actual Screenshot
// (sharp) code path: FLAT is a solid fill (max channel stdev 0), NOISY is a
// checkerboard (stdev ~128). See the calibration in bug cmrb9ifew... where the
// blank hero frame measured 0 and every content frame measured 11+.
const FLAT_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGP4/v0TVsQwtCQA5jG4AfvtdEQAAAAASUVORK5CYII=",
    "base64",
);
const NOISY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAF0lEQVR4nGNgYGD4//8/FhK7KAQMPh0AXXNfodQ6cUAAAAAASUVORK5CYII=",
    "base64",
);

function loaderReturning(buffer: Buffer): ScreenshotLoader {
    return { loadScreenshot: async () => buffer };
}

interface PrimaryScreenshotRef {
    stepOrder: number;
    timing: "before" | "after";
}

function reportBugInput(primaryScreenshot: PrimaryScreenshotRef | undefined) {
    return {
        testCaseId: TEST_CASE_ID,
        title: "Login button does nothing",
        description: "Clicking login has no effect",
        severity: "high",
        evidence: [{ type: "screenshot", description: "the failure frame" }],
        reasoning: "the handler throws before navigation",
        suspectedCause: {
            explanation: "the click handler early-returns on a null session",
            codeReferences: [{ file: "src/login.ts", lines: "42-58" }],
        },
        report: {
            actualBehavior: "the page stayed on the login screen",
            narrativeMarkdown: "## Why\nThe button click is swallowed.",
            primaryScreenshot,
        },
    };
}

function step(overrides: Partial<RenderableReviewStep> & { order: number }): RenderableReviewStep {
    return {
        interaction: "click",
        params: { description: "Login" },
        status: "success",
        output: { point: { x: 10, y: 20 } },
        screenshotBeforeKey: `runs/r1/step-${overrides.order}-before.png`,
        screenshotAfterKey: `runs/r1/step-${overrides.order}-after.png`,
        ...overrides,
    };
}

function loopWithSteps(steps: RenderableReviewStep[], screenshotLoader?: ScreenshotLoader) {
    return makeHealingLoop({
        failureKeysByTestCaseId: new Map([[TEST_CASE_ID, FAILURE_KEY]]),
        failureKeys: new Set([FAILURE_KEY]),
        reviewLinksByTestCaseId: new Map([[TEST_CASE_ID, { runReviewId: "rr-1" }]]),
        stepEvidenceByFailureKey: new Map([[FAILURE_KEY, steps]]),
        screenshotLoader,
    });
}

function reportedAction(actions: HealingAction[]) {
    const action = actions[0];
    if (action == null || action.kind !== "report_bug") throw new Error("expected a report_bug action");
    return action;
}

describe("HealingReportBugTool primaryScreenshot resolution", () => {
    it("resolves the referenced step's after-frame to its storage key and derives the pin from its resolved point", async () => {
        const loop = loopWithSteps([step({ order: 3 })]);

        const result = await executeTool<ToolEnvelope<{ testCaseId: string }>>(
            new HealingReportBugTool(),
            reportBugInput({ stepOrder: 3, timing: "after" }),
            loop,
        );

        expect(result.success).toBe(true);
        expect(reportedAction(loop.actions).report?.primaryScreenshot).toEqual({
            s3Key: "runs/r1/step-3-after.png",
            pin: { x: 10, y: 20 },
        });
    });

    it("honors the before/after timing the agent designated", async () => {
        const loop = loopWithSteps([step({ order: 2 })]);

        await executeTool(new HealingReportBugTool(), reportBugInput({ stepOrder: 2, timing: "before" }), loop);

        expect(reportedAction(loop.actions).report?.primaryScreenshot?.s3Key).toBe("runs/r1/step-2-before.png");
    });

    it("omits the pin when the referenced step resolved no interaction point", async () => {
        const loop = loopWithSteps([step({ order: 1, output: { outcome: "success" } })]);

        await executeTool(new HealingReportBugTool(), reportBugInput({ stepOrder: 1, timing: "after" }), loop);

        expect(reportedAction(loop.actions).report?.primaryScreenshot).toEqual({ s3Key: "runs/r1/step-1-after.png" });
    });

    it("drops a reference to a step that was never captured (falls back to the failing-step frame later)", async () => {
        const loop = loopWithSteps([step({ order: 3 })]);

        await executeTool(new HealingReportBugTool(), reportBugInput({ stepOrder: 99, timing: "after" }), loop);

        const action = reportedAction(loop.actions);
        expect(action.report?.primaryScreenshot).toBeUndefined();
        expect(action.report?.actualBehavior).toBe("the page stayed on the login screen");
    });

    it("drops a reference whose timing has no captured screenshot", async () => {
        const loop = loopWithSteps([step({ order: 4, screenshotAfterKey: undefined })]);

        await executeTool(new HealingReportBugTool(), reportBugInput({ stepOrder: 4, timing: "after" }), loop);

        expect(reportedAction(loop.actions).report?.primaryScreenshot).toBeUndefined();
    });

    it("records a report without a primaryScreenshot when the agent designated none", async () => {
        const loop = loopWithSteps([step({ order: 3 })]);

        await executeTool(new HealingReportBugTool(), reportBugInput(undefined), loop);

        const action = reportedAction(loop.actions);
        expect(action.report?.primaryScreenshot).toBeUndefined();
        expect(action.report?.narrativeMarkdown).toContain("The button click is swallowed.");
    });

    it("drops a designated frame that is near-uniform (blank/loading), falling back to the failing-step frame", async () => {
        const loop = loopWithSteps([step({ order: 3 })], loaderReturning(FLAT_PNG));

        await executeTool(new HealingReportBugTool(), reportBugInput({ stepOrder: 3, timing: "after" }), loop);

        expect(reportedAction(loop.actions).report?.primaryScreenshot).toBeUndefined();
    });

    it("keeps a designated frame that has real content", async () => {
        const loop = loopWithSteps([step({ order: 3 })], loaderReturning(NOISY_PNG));

        await executeTool(new HealingReportBugTool(), reportBugInput({ stepOrder: 3, timing: "after" }), loop);

        expect(reportedAction(loop.actions).report?.primaryScreenshot?.s3Key).toBe("runs/r1/step-3-after.png");
    });
});
