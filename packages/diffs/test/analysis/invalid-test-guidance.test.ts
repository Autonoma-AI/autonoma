import { describe, expect, it } from "vitest";
import { CLASSIFIER_SYSTEM_PROMPT } from "../../src/analysis/classify/prompt";

describe("invalid-test classifier guidance", () => {
    it("leaves deletion to the model when failed rewrites show no meaningful plan remains", () => {
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("A failed self-heal is evidence, NEVER an automatic deletion rule:");
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain(
            "YOU decide whether the accumulated description, run, code, and prior attempts establish",
        );
        expect(CLASSIFIER_SYSTEM_PROMPT).toContain("do not invent a weaker plan merely to keep the test.");
    });
});
