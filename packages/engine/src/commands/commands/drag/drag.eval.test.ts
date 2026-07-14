import { type BoundingBox, boundingBoxContainsPoint } from "@autonoma/image";
import { GeminiObjectDetector, ObjectPointDetector } from "@autonoma/visual-ai";
import { describe, expect } from "vitest";
import { baseFakeContext, commandTestFunction } from "../../test-utils/command-test";
import { FakeMouseDriver } from "../../test-utils/fake-mouse.driver";
import { getTestImage } from "../../test-utils/test-images";
import { testModelRegistry } from "../../test-utils/test-model-registry";
import { DragCommand } from "./drag.command";

const MELI_SEARCH_BAR_BOUNDS: BoundingBox = {
    x: 232,
    y: 8,
    width: 588,
    height: 40,
};

const MELI_CART_ICON_BOUNDS: BoundingBox = {
    x: 1208,
    y: 71,
    width: 22,
    height: 17,
};

const dragTest = commandTestFunction(() => ({
    ...baseFakeContext(),
    mouse: new FakeMouseDriver(),
}));

describe("DragCommand", () => {
    const MELI_HOMEPAGE = getTestImage("MELI_HOMEPAGE");

    const pointDetector = new ObjectPointDetector(
        new GeminiObjectDetector(testModelRegistry.getModel({ model: "smart-visual", tag: "point-detection" })),
    );

    const dragCommand = new DragCommand(pointDetector);

    dragTest("drags from the search bar to the cart icon on MercadoLibre", async ({ makeContext }) => {
        const context = makeContext();
        const { screen, mouse } = context;
        screen.setScreenshot(MELI_HOMEPAGE);

        const result = await dragCommand.execute(
            { startDescription: "main search bar input field", endDescription: "shopping cart icon" },
            context,
        );

        expect(mouse.drags).toHaveLength(1);

        // biome-ignore lint/style/noNonNullAssertion: Length == 1
        const drag = mouse.drags[0]!;

        expect(result.startPoint).toEqual(drag.startPoint);
        expect(result.endPoint).toEqual(drag.endPoint);
        expect(boundingBoxContainsPoint(MELI_SEARCH_BAR_BOUNDS, drag.startPoint)).toBe(true);
        expect(boundingBoxContainsPoint(MELI_CART_ICON_BOUNDS, drag.endPoint)).toBe(true);
    });
});
