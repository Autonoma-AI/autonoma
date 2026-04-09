import { describe, expect, it, vi } from "vitest";
import type { DiffsAgentCallbacks } from "../src/callbacks";
import { buildBugFoundTool } from "../src/tools/bug-found-tool";
import { createEmptyCollector } from "./create-collector";
import { executeTool } from "./execute-tool";

function createMockCallbacks(): DiffsAgentCallbacks {
    return {
        triggerTestsAndWait: vi.fn(),
        quarantineTest: vi.fn(),
        modifyTest: vi.fn(),
        updateSkill: vi.fn(),
        reportBug: vi.fn().mockResolvedValue(undefined),
    };
}

const bugReport = {
    slug: "checkout-flow",
    testName: "Checkout flow",
    summary: "Payment button is unresponsive after clicking",
    detailedExplanation:
        "The test navigated to /checkout, filled in shipping details, " +
        "and attempted to click the 'Pay Now' button. The button was visible " +
        "but clicking it had no effect. Expected: payment modal to open. " +
        "Actual: nothing happened after click.",
    affectedFiles: ["src/components/checkout/PaymentButton.tsx", "src/hooks/usePayment.ts"],
    fixPrompt:
        "There is a bug in the checkout flow. The 'Pay Now' button in " +
        "src/components/checkout/PaymentButton.tsx is unresponsive. " +
        "Check the onClick handler and the usePayment hook in src/hooks/usePayment.ts. " +
        "The button should open a payment modal when clicked. " +
        "Likely cause: the onClick handler is not wired up or the payment hook " +
        "is returning early before triggering the modal.",
};

describe("bug_found tool", () => {
    it("rejects if test has not been run", async () => {
        const callbacks = createMockCallbacks();
        const completedRuns = new Set<string>();
        const tool = buildBugFoundTool(callbacks, completedRuns, createEmptyCollector());

        const result = await executeTool<{ error: string }>(tool, bugReport);

        expect(result.error).toContain("has not been run yet");
        expect(callbacks.reportBug).not.toHaveBeenCalled();
    });

    it("reports a bug for a test that has been run", async () => {
        const callbacks = createMockCallbacks();
        const completedRuns = new Set<string>(["checkout-flow"]);
        const collector = createEmptyCollector();
        const tool = buildBugFoundTool(callbacks, completedRuns, collector);

        const result = await executeTool<{ success: boolean }>(tool, bugReport);

        expect(result.success).toBe(true);
        expect(callbacks.reportBug).toHaveBeenCalledWith(bugReport);
        expect(collector.bugReports).toHaveLength(1);
    });

    it("passes the full bug report to the callback", async () => {
        const callbacks = createMockCallbacks();
        const completedRuns = new Set<string>(["checkout-flow"]);
        const tool = buildBugFoundTool(callbacks, completedRuns, createEmptyCollector());

        await executeTool(tool, bugReport);

        const calledWith = vi.mocked(callbacks.reportBug).mock.calls[0]?.[0];
        expect(calledWith?.summary).toBe("Payment button is unresponsive after clicking");
        expect(calledWith?.fixPrompt).toContain("src/components/checkout/PaymentButton.tsx");
        expect(calledWith?.affectedFiles).toHaveLength(2);
    });
});
