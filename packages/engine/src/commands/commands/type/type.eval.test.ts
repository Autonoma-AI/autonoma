import { type BoundingBox, boundingBoxContainsPoint } from "@autonoma/image";
import { GeminiObjectDetector, ObjectPointDetector } from "@autonoma/visual-ai";
import { describe, expect } from "vitest";
import { baseFakeContext, commandTestFunction } from "../../test-utils/command-test";
import { FakeKeyboardDriver } from "../../test-utils/fake-keyboard.driver";
import { FakeMouseDriver } from "../../test-utils/fake-mouse.driver";
import { getTestImage } from "../../test-utils/test-images";
import { testModelRegistry } from "../../test-utils/test-model-registry";
import { TypeCommand } from "./type.command";

const MELI_SEARCH_BAR_BOUNDS: BoundingBox = {
    x: 232,
    y: 8,
    width: 589,
    height: 40,
};

const typeTest = commandTestFunction(() => ({
    ...baseFakeContext(),
    mouse: new FakeMouseDriver(),
    keyboard: new FakeKeyboardDriver(),
}));

describe("TypeCommand", () => {
    const MELI_HOMEPAGE = getTestImage("MELI_HOMEPAGE");

    const pointDetector = new ObjectPointDetector(
        new GeminiObjectDetector(
            testModelRegistry.getModel({
                model: "smart-visual",
                tag: "point-detection",
            }),
        ),
    );

    const typeCommand = new TypeCommand(pointDetector);

    typeTest("types text into the MercadoLibre search bar", async ({ makeContext }) => {
        const context = makeContext();
        const { screen, mouse, keyboard } = context;
        screen.setScreenshot(MELI_HOMEPAGE);

        await typeCommand.execute({ description: "main search bar", text: "laptop gaming", overwrite: false }, context);

        expect(mouse.clicks).toHaveLength(1);
        expect(keyboard.text).toBe("laptop gaming");

        // biome-ignore lint/style/noNonNullAssertion: Length > 1
        const clickPoint = mouse.clicks[0]!.point;
        expect(boundingBoxContainsPoint(MELI_SEARCH_BAR_BOUNDS, clickPoint)).toBe(true);
    });

    // TODO: Add tests for overwrite functionality and error handling when the element is not found
});
