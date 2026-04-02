import { describe, expect, test } from "vitest";
import { type RunCompletionData, buildSlackRunCompletionMessage } from "../src/slack-message-builder";

function baseData(overrides?: Partial<RunCompletionData>): RunCompletionData {
    return {
        testName: "Login flow",
        applicationName: "My App",
        status: "success",
        runUrl: "https://app.autonoma.ai/app/my-app/branch/main/runs/run-123",
        ...overrides,
    };
}

describe("buildSlackRunCompletionMessage", () => {
    test("success message uses check mark emoji in header", () => {
        const message = buildSlackRunCompletionMessage(baseData());
        const header = message.blocks[0];

        expect(header?.type).toBe("header");
        expect(header?.text?.text).toContain(":white_check_mark:");
        expect(header?.text?.text).toContain("Test Passed");
    });

    test("failed message uses X emoji in header", () => {
        const message = buildSlackRunCompletionMessage(baseData({ status: "failed" }));
        const header = message.blocks[0];

        expect(header?.text?.text).toContain(":x:");
        expect(header?.text?.text).toContain("Test Failed");
    });

    test("includes test name and application name in body", () => {
        const message = buildSlackRunCompletionMessage(baseData());
        const body = message.blocks[1];

        expect(body?.text?.text).toContain("Login flow");
        expect(body?.text?.text).toContain("My App");
    });

    test("includes reasoning section for failed runs with reasoning", () => {
        const message = buildSlackRunCompletionMessage(
            baseData({ status: "failed", reasoning: "Button not found on page" }),
        );
        const reasoningBlock = message.blocks.find((b) => b.text?.text?.includes("Reasoning"));

        expect(reasoningBlock).toBeDefined();
        expect(reasoningBlock?.text?.text).toContain("Button not found on page");
    });

    test("omits reasoning section when reasoning is undefined", () => {
        const message = buildSlackRunCompletionMessage(baseData({ status: "failed" }));
        const reasoningBlock = message.blocks.find((b) => b.text?.text?.includes("Reasoning"));

        expect(reasoningBlock).toBeUndefined();
    });

    test("omits reasoning section for success even if reasoning is provided", () => {
        const message = buildSlackRunCompletionMessage(baseData({ status: "success", reasoning: "All good" }));
        const reasoningBlock = message.blocks.find((b) => b.text?.text?.includes("Reasoning"));

        expect(reasoningBlock).toBeUndefined();
    });

    test("includes run URL in action button", () => {
        const message = buildSlackRunCompletionMessage(baseData());
        const actionsBlock = message.blocks.find((b) => b.type === "actions");

        expect(actionsBlock?.elements?.[0]?.url).toBe("https://app.autonoma.ai/app/my-app/branch/main/runs/run-123");
        expect(actionsBlock?.elements?.[0]?.text?.text).toBe("View Run");
    });
});
