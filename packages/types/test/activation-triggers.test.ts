import { describe, expect, it } from "vitest";
import { AnalysisTriggerLabelSchema } from "../src/schemas/activation-triggers";

describe("AnalysisTriggerLabelSchema", () => {
    it("accepts an ordinary GitHub label", () => {
        expect(AnalysisTriggerLabelSchema.parse("autonoma:analyze")).toBe("autonoma:analyze");
    });

    it("trims surrounding whitespace so a padded label stores clean", () => {
        expect(AnalysisTriggerLabelSchema.parse("  team:review  ")).toBe("team:review");
    });

    it("accepts a 50-character label (GitHub's cap) and internal spaces", () => {
        const atLimit = "x".repeat(50);
        expect(AnalysisTriggerLabelSchema.parse(atLimit)).toBe(atLimit);
        expect(AnalysisTriggerLabelSchema.parse("needs analysis")).toBe("needs analysis");
    });

    it("rejects an empty or whitespace-only label", () => {
        expect(AnalysisTriggerLabelSchema.safeParse("").success).toBe(false);
        expect(AnalysisTriggerLabelSchema.safeParse("   ").success).toBe(false);
    });

    it("rejects a label longer than 50 characters (after trimming)", () => {
        expect(AnalysisTriggerLabelSchema.safeParse("x".repeat(51)).success).toBe(false);
        // Trailing whitespace is trimmed first, so the 50 non-space chars still pass.
        expect(AnalysisTriggerLabelSchema.parse(`${"x".repeat(50)}   `)).toBe("x".repeat(50));
    });

    it("rejects control characters GitHub disallows in a label", () => {
        expect(AnalysisTriggerLabelSchema.safeParse("bad\nlabel").success).toBe(false);
        expect(AnalysisTriggerLabelSchema.safeParse("bad\tlabel").success).toBe(false);
    });
});
