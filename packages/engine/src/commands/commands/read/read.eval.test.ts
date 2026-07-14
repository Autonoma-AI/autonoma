import { TextExtractor } from "@autonoma/visual-ai";
import { describe, expect, it } from "vitest";
import { baseFakeContext, commandTestFunction } from "../../test-utils/command-test";
import { getTestImage } from "../../test-utils/test-images";
import { testModelRegistry } from "../../test-utils/test-model-registry";
import { ReadCommand } from "./read.command";

const readTest = commandTestFunction(() => baseFakeContext());

describe("ReadCommand", () => {
    const MELI_HOMEPAGE = getTestImage("MELI_HOMEPAGE");

    const textExtractor = new TextExtractor(
        testModelRegistry.getModel({ model: "smart-visual", tag: "text-extraction" }),
    );

    const readCommand = new ReadCommand(textExtractor);

    readTest("extracts the main title text from MercadoLibre homepage", async ({ makeContext }) => {
        const context = makeContext();
        context.screen.setScreenshot(MELI_HOMEPAGE);

        const result = await readCommand.execute(
            { description: "the main promotional text or banner heading", variableName: "promoText" },
            context,
        );

        expect(result.value).toBeTruthy();
        expect(result.value.length).toBeGreaterThan(0);
        expect(result.outcome).toContain("{{promoText}}");
    });

    readTest("extracts the logo text from MercadoLibre homepage", async ({ makeContext }) => {
        const context = makeContext();
        context.screen.setScreenshot(MELI_HOMEPAGE);

        const result = await readCommand.execute(
            { description: "the site name or logo text at the top of the page", variableName: "siteName" },
            context,
        );

        expect(result.value).toBeTruthy();
        expect(result.value.length).toBeGreaterThan(0);
        expect(result.outcome).toContain("{{siteName}}");
    });

    readTest("returns outcome with the correct variable template syntax", async ({ makeContext }) => {
        const context = makeContext();
        context.screen.setScreenshot(MELI_HOMEPAGE);

        const result = await readCommand.execute(
            { description: "any visible text on the page", variableName: "myVar" },
            context,
        );

        expect(result.outcome).toContain('and stored as "{{myVar}}"');
    });

    it("should use the correct interaction name", () => {
        expect(readCommand.interaction).toBe("read");
    });
});
