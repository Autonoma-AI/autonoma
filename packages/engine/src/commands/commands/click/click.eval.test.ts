import { type BoundingBox, boundingBoxContainsPoint } from "@autonoma/image";
import { GeminiObjectDetector, ObjectPointDetector } from "@autonoma/visual-ai";
import { describe, expect } from "vitest";
import type { WebClickOptions } from "../../../platform";
import { baseFakeContext, commandTestFunction } from "../../test-utils/command-test";
import { FakeMouseDriver } from "../../test-utils/fake-mouse.driver";
import { getTestImage } from "../../test-utils/test-images";
import { testModelRegistry } from "../../test-utils/test-model-registry";
import { WebClickCommand } from "./web-click.command";

const MELI_SEARCH_BAR_BOUNDS: BoundingBox = {
    x: 232,
    y: 8,
    width: 589,
    height: 40,
};

const KAVAK_SEARCH_BAR_BOUNDS: BoundingBox = {
    x: 732,
    y: 347,
    width: 414,
    height: 50,
};

const clickTest = commandTestFunction(() => ({
    ...baseFakeContext(),
    mouse: new FakeMouseDriver<WebClickOptions>(),
}));

describe("WebClickCommand", () => {
    const MELI_HOMEPAGE = getTestImage("MELI_HOMEPAGE");
    const KAVAK_HOMEPAGE = getTestImage("KAVAK_HOMEPAGE");

    const pointDetector = new ObjectPointDetector(
        new GeminiObjectDetector(testModelRegistry.getModel({ model: "smart-visual", tag: "point-detection" })),
    );

    const clickCommand = new WebClickCommand(pointDetector);

    clickTest("clicks within the search bar on MercadoLibre", async ({ makeContext }) => {
        const context = makeContext();
        const { screen, mouse } = context;
        screen.setScreenshot(MELI_HOMEPAGE);

        await clickCommand.execute({ description: "main search bar input field", options: {} }, context);

        expect(mouse.clicks).toHaveLength(1);

        // biome-ignore lint/style/noNonNullAssertion: Length == 1
        const clickPoint = mouse.clicks[0]!.point;

        expect(boundingBoxContainsPoint(MELI_SEARCH_BAR_BOUNDS, clickPoint)).toBe(true);
    });

    clickTest("clicks within the search bar on Kavak", async ({ makeContext }) => {
        const context = makeContext();
        const { screen, mouse } = context;
        screen.setScreenshot(KAVAK_HOMEPAGE);

        const result = await clickCommand.execute(
            { description: "main search input field at the top", options: {} },
            context,
        );

        expect(mouse.clicks).toHaveLength(1);

        // biome-ignore lint/style/noNonNullAssertion: Length == 1
        const clickPoint = mouse.clicks[0]!.point;

        expect(result.point).toEqual(clickPoint);
        expect(boundingBoxContainsPoint(KAVAK_SEARCH_BAR_BOUNDS, clickPoint)).toBe(true);
    });
});
