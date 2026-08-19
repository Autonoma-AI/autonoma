import { describe, expect, it } from "vitest";
import { CLASSIFIER_SYSTEM_PROMPT } from "../../src/analysis/classify/prompt";

describe("invalid-test classifier guidance", () => {
    it("leaves deletion to the model when failed rewrites show no meaningful plan remains", () => {
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain(
            "A failed self-heal is EVIDENCE about the description, never an automatic deletion AND never an automatic salvage",
        );
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("the number of failed repairs never decides it; you do");
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("Never fabricate a weaker plan just to keep a test.");
    });
});
