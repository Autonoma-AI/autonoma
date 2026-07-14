import { AssertionSplitter } from "@autonoma/ai";
import { AssertChecker } from "@autonoma/visual-ai";
import { describe, expect } from "vitest";
import { baseFakeContext, commandTestFunction } from "../../test-utils/command-test";
import { getTestImage } from "../../test-utils/test-images";
import { testModelRegistry } from "../../test-utils/test-model-registry";
import { AssertCommand, AssertionFailedError } from "./assert.command";

const MELI_HOMEPAGE = getTestImage("MELI_HOMEPAGE");

const assertTest = commandTestFunction(baseFakeContext);

describe("AssertCommand", () => {
    const assertChecker = new AssertChecker(testModelRegistry.getModel({ model: "smart-visual", tag: "assert" }));
    const assertionSplitter = new AssertionSplitter(
        testModelRegistry.getModel({ model: "fast-text", tag: "assertion-splitter" }),
    );

    const assertCommand = new AssertCommand(assertChecker, assertionSplitter);

    assertTest("passes for a true assertion", async ({ makeContext }) => {
        const context = makeContext();
        const { screen } = context;
        screen.setScreenshot(MELI_HOMEPAGE);

        const result = await assertCommand.execute({ instruction: "The Mercado Libre logo is visible" }, context);

        expect(result.results[0]?.metCondition).toBe(true);
    });

    assertTest("throws AssertionFailedError for a false assertion", async ({ makeContext }) => {
        const context = makeContext();
        const { screen } = context;
        screen.setScreenshot(MELI_HOMEPAGE);

        await expect(
            assertCommand.execute({ instruction: "There is a red dinosaur on the screen" }, context),
        ).rejects.toThrow(AssertionFailedError);
    });

    assertTest("splits a compound instruction and reports partial failure", async ({ makeContext }) => {
        const context = makeContext();
        const { screen } = context;
        screen.setScreenshot(MELI_HOMEPAGE);

        await expect(
            assertCommand.execute(
                { instruction: "The Mercado Libre logo is visible and there is a large red dinosaur on screen" },
                context,
            ),
        ).rejects.toThrow(AssertionFailedError);
    });
});
