import { GeminiObjectDetector, ObjectPointDetector, VisualConditionChecker } from "@autonoma/visual-ai";
import { describe, expect } from "vitest";
import { baseFakeContext, commandTestFunction } from "../../test-utils/command-test";
import { FakeMouseDriver } from "../../test-utils/fake-mouse.driver";
import { getTestImage } from "../../test-utils/test-images";
import { testModelRegistry } from "../../test-utils/test-model-registry";
import { ScrollCommand, ScrollConditionNotMetError } from "./scroll.command";

const scrollTest = commandTestFunction(() => ({ ...baseFakeContext(), mouse: new FakeMouseDriver() }));

describe("ScrollCommand", () => {
    const MELI_HOMEPAGE = getTestImage("MELI_HOMEPAGE");
    const KAVAK_HOMEPAGE = getTestImage("KAVAK_HOMEPAGE");
    const KAVAK_HOMEPAGE_SCROLLED = getTestImage("KAVAK_HOMEPAGE_SCROLLED");
    const GITHUB_ISSUE_LABELS_1 = getTestImage("GITHUB_ISSUE_LABELS_1");
    const GITHUB_ISSUE_LABELS_2 = getTestImage("GITHUB_ISSUE_LABELS_2");

    const pointDetector = new ObjectPointDetector(
        new GeminiObjectDetector(testModelRegistry.getModel({ model: "smart-visual", tag: "point-detection" })),
    );

    const visualConditionChecker = new VisualConditionChecker({
        model: testModelRegistry.getModel({ model: "smart-visual", tag: "visual-condition" }),
    });

    const scrollCommand = new ScrollCommand(pointDetector, visualConditionChecker);

    scrollTest("stops scrolling immediately when condition is already met", async ({ makeContext }) => {
        const context = makeContext();
        const { screen } = context;
        screen.setScreenshot(MELI_HOMEPAGE);

        const result = await scrollCommand.execute(
            {
                direction: "down",
                condition: "The Mercado Libre logo is visible at the top",
                maxScrolls: 10,
            },
            context,
        );

        expect(result.conditionMet).toBe(true);
        expect(result.scrollsPerformed).toBe(0);
    });

    scrollTest("scrolls until condition is met", async ({ makeContext }) => {
        const context = makeContext();
        const { screen } = context;
        screen.setScreenshot(KAVAK_HOMEPAGE);

        // Switch to the scrolled screenshot after 1.2s so the condition becomes met
        setTimeout(() => screen.setScreenshot(KAVAK_HOMEPAGE_SCROLLED), 1200);

        const result = await scrollCommand.execute(
            {
                direction: "down",
                condition: "the blue Simular button is visible",
                maxScrolls: 10,
            },
            context,
        );

        expect(result.conditionMet).toBe(true);
        expect(result.scrollsPerformed).toBeGreaterThanOrEqual(1);
    });

    scrollTest("throws error when max scrolls exceeded", async ({ makeContext }) => {
        const context = makeContext();
        const { screen } = context;
        screen.setScreenshot(KAVAK_HOMEPAGE);

        await expect(
            scrollCommand.execute(
                {
                    direction: "down",
                    condition: "a flying pig is visible",
                    maxScrolls: 2,
                },
                context,
            ),
        ).rejects.toThrow(ScrollConditionNotMetError);
    });

    scrollTest("scrolls through GitHub issue labels until 'good first issue' is visible", async ({ makeContext }) => {
        const context = makeContext();
        const { screen } = context;
        screen.setScreenshot(GITHUB_ISSUE_LABELS_1);

        // Switch to the scrolled screenshot after 5s. This gives the point detector time to detect the point.
        // Warning, this is a hack and should be eventually replaced with a more robust solution.
        setTimeout(() => screen.setScreenshot(GITHUB_ISSUE_LABELS_2), 5000);

        const result = await scrollCommand.execute(
            {
                elementDescription: "issue label list",
                direction: "down",
                condition: "the 'good first issue' label is visible",
                maxScrolls: 10,
            },
            context,
        );

        expect(result.conditionMet).toBe(true);
        expect(result.scrollsPerformed).toBeGreaterThanOrEqual(1);
    });
});
