import { describe, expect, it } from "vitest";
import { formatDryRunError } from "./format-dry-run-error";

describe("formatDryRunError", () => {
    // The regression this covers: the dry-run button used to drop the thrown error entirely
    // and record a bare failure, so a recipe that could not resolve showed a red dot with no
    // reason anywhere once its toast expired.
    it("reads the message off a thrown error", () => {
        expect(formatDryRunError(new Error("Unknown recipe variable: testRunId"))).toBe(
            "Unknown recipe variable: testRunId",
        );
    });

    it("passes through the structured error the procedure resolves with", () => {
        expect(formatDryRunError({ message: "SDK returned HTTP 500" })).toContain("SDK returned HTTP 500");
    });

    it("takes a plain string as-is", () => {
        expect(formatDryRunError("down failed")).toBe("down failed");
    });

    it("has nothing to say when the run carried no error", () => {
        expect(formatDryRunError(undefined)).toBeUndefined();
        expect(formatDryRunError(null)).toBeUndefined();
        expect(formatDryRunError("")).toBeUndefined();
    });
});
