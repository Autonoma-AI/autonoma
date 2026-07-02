import { describe, expect } from "vitest";
import { baseFakeContext, commandTestFunction } from "../../test-utils/command-test";
import { FakeClipboardDriver } from "../../test-utils/fake-clipboard.driver";
import { SaveClipboardCommand } from "./save-clipboard.command";

const saveClipboardTest = commandTestFunction((clipboardValue: string) => ({
    ...baseFakeContext(),
    clipboard: new FakeClipboardDriver(clipboardValue),
}));

describe("SaveClipboardCommand", () => {
    const command = new SaveClipboardCommand();

    saveClipboardTest("should read clipboard content and return it with the variable name", async ({ makeContext }) => {
        const context = makeContext("ORD-12345");

        const result = await command.execute({ variableName: "orderId" }, context);

        expect(result.value).toBe("ORD-12345");
        expect(result.outcome).toContain("ORD-12345");
        expect(result.outcome).toContain("{{orderId}}");
    });

    saveClipboardTest("should handle empty clipboard content", async ({ makeContext }) => {
        const context = makeContext("");

        const result = await command.execute({ variableName: "emptyVar" }, context);

        expect(result.value).toBe("");
        expect(result.outcome).toContain("{{emptyVar}}");
    });

    saveClipboardTest("should handle clipboard content with special characters", async ({ makeContext }) => {
        const context = makeContext("user+test@example.com");

        const result = await command.execute({ variableName: "email" }, context);

        expect(result.value).toBe("user+test@example.com");
        expect(result.outcome).toContain("user+test@example.com");
        expect(result.outcome).toContain("{{email}}");
    });

    saveClipboardTest("should handle multiline clipboard content", async ({ makeContext }) => {
        const context = makeContext("line1\nline2\nline3");

        const result = await command.execute({ variableName: "multiline" }, context);

        expect(result.value).toBe("line1\nline2\nline3");
    });
});
