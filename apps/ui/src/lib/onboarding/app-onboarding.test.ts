import { describe, expect, it } from "vitest";
import { isMidOnboarding } from "./app-onboarding";

describe("isMidOnboarding", () => {
    it("is true for an app parked before go-live", () => {
        expect(isMidOnboarding({ onboardingState: { step: "previewkit_configuring" } })).toBe(true);
    });

    it("is false once the app is live", () => {
        expect(isMidOnboarding({ onboardingState: { step: "completed" } })).toBe(false);
    });

    // The divergence this helper exists to make explicit: the shared predicate fails closed on
    // an absent step, but a legacy app with no onboarding row is usable and must not be listed
    // as unfinished setup.
    it("is false for a legacy app with no onboarding row", () => {
        expect(isMidOnboarding({ onboardingState: null })).toBe(false);
        expect(isMidOnboarding({})).toBe(false);
    });
});
