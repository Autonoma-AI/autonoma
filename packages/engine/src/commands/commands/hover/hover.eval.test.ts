import { type BoundingBox, boundingBoxContainsPoint } from "@autonoma/image";
import { GeminiObjectDetector, ObjectPointDetector } from "@autonoma/visual-ai";
import { describe, expect } from "vitest";
import { baseFakeContext, commandTestFunction } from "../../test-utils/command-test";
import { FakeMouseDriver } from "../../test-utils/fake-mouse.driver";
import { getTestImage } from "../../test-utils/test-images";
import { testModelRegistry } from "../../test-utils/test-model-registry";
import { WebHoverCommand } from "./web-hover.command";

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

const hoverTest = commandTestFunction(() => ({
    ...baseFakeContext(),
    mouse: new FakeMouseDriver(),
}));

describe("WebHoverCommand", () => {
    const MELI_HOMEPAGE = getTestImage("MELI_HOMEPAGE");
    const KAVAK_HOMEPAGE = getTestImage("KAVAK_HOMEPAGE");

    const pointDetector = new ObjectPointDetector(
        new GeminiObjectDetector(testModelRegistry.getModel({ model: "smart-visual", tag: "point-detection" })),
    );

    const hoverCommand = new WebHoverCommand(pointDetector);

    hoverTest("hovers within the search bar on MercadoLibre", async ({ makeContext }) => {
        const context = makeContext();
        const { screen, mouse } = context;
        screen.setScreenshot(MELI_HOMEPAGE);

        await hoverCommand.execute({ description: "main search bar input field" }, context);

        expect(mouse.hovers).toHaveLength(1);

        // biome-ignore lint/style/noNonNullAssertion: Length == 1
        const hoverPoint = mouse.hovers[0]!;

        expect(boundingBoxContainsPoint(MELI_SEARCH_BAR_BOUNDS, hoverPoint)).toBe(true);
    });

    hoverTest("hovers within the search bar on Kavak", async ({ makeContext }) => {
        const context = makeContext();
        const { screen, mouse } = context;
        screen.setScreenshot(KAVAK_HOMEPAGE);

        const result = await hoverCommand.execute({ description: "main search input field at the top" }, context);

        expect(mouse.hovers).toHaveLength(1);

        // biome-ignore lint/style/noNonNullAssertion: Length == 1
        const hoverPoint = mouse.hovers[0]!;

        expect(result.point).toEqual(hoverPoint);
        expect(boundingBoxContainsPoint(KAVAK_SEARCH_BAR_BOUNDS, hoverPoint)).toBe(true);
    });
});
