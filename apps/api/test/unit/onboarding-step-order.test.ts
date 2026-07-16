import { describe, expect, it } from "vitest";
import { isStepAtOrPast } from "../../src/routes/onboarding/onboarding-step-order";

describe("isStepAtOrPast", () => {
    it("treats a step as at-or-past itself", () => {
        expect(isStepAtOrPast("preview_verified", "preview_verified")).toBe(true);
    });

    it("is true for a later step and false for an earlier one", () => {
        expect(isStepAtOrPast("completed", "preview_verified")).toBe(true);
        expect(isStepAtOrPast("previewkit_deploying", "preview_verified")).toBe(false);
    });

    it("orders the full sequence from github to completed", () => {
        expect(isStepAtOrPast("completed", "github")).toBe(true);
        expect(isStepAtOrPast("github", "completed")).toBe(false);
    });
});
