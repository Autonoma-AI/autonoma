import { OnboardingStep } from "@autonoma/db";
import { describe, expect, it } from "vitest";
import {
    FIRST_ONBOARDING_STEP,
    isStepAtOrPast,
    OnboardingStepSchema,
} from "../../src/routes/onboarding/onboarding-step-order";

describe("isStepAtOrPast", () => {
    it("treats a step as at-or-past itself", () => {
        expect(isStepAtOrPast("preview_verified", "preview_verified")).toBe(true);
    });

    it("is true for a later step and false for an earlier one", () => {
        expect(isStepAtOrPast("completed", "preview_verified")).toBe(true);
        expect(isStepAtOrPast("previewkit_deploying", "preview_verified")).toBe(false);
    });

    it("orders the full sequence from github to completed", () => {
        expect(isStepAtOrPast("completed", FIRST_ONBOARDING_STEP)).toBe(true);
        expect(isStepAtOrPast(FIRST_ONBOARDING_STEP, "completed")).toBe(false);
    });

    // A retired step is not in the order at all, so it must sort before every target rather
    // than reading as further along than an app that has actually started the current flow.
    it("sorts a retired step before every current step", () => {
        expect(isStepAtOrPast("webhook_configuring", FIRST_ONBOARDING_STEP)).toBe(false);
        expect(isStepAtOrPast("webhook_configuring", "completed")).toBe(false);
    });
});

describe("OnboardingStepSchema", () => {
    // Derived from the Prisma enum rather than re-listing it, so this asserts the derivation
    // rather than a copy: every generated member parses, and nothing else does.
    it("accepts every step the database defines", () => {
        for (const step of Object.values(OnboardingStep)) {
            expect(OnboardingStepSchema.safeParse(step).success).toBe(true);
        }
    });

    it("rejects a value that is not a step", () => {
        expect(OnboardingStepSchema.safeParse("complete").success).toBe(false);
    });
});
