import { describe, expect, it } from "vitest";
import { hasGoneLive, LIVE_STEP } from "./onboarding-step";

describe("hasGoneLive", () => {
    it("is true only for the live step", () => {
        expect(hasGoneLive(LIVE_STEP)).toBe(true);
        expect(hasGoneLive("diff_trigger")).toBe(false);
        expect(hasGoneLive("preview_verified")).toBe(false);
    });

    // The whole point of the shared predicate: an application with no onboarding row must
    // never read as live, because everything that asks is about to write to a customer's repo.
    it("fails closed on an absent step", () => {
        expect(hasGoneLive(undefined)).toBe(false);
        expect(hasGoneLive(null)).toBe(false);
    });

    // A near-miss is the failure this replaced: before the predicate, call sites compared
    // against the literal themselves and a typo compiled.
    it("does not match a near-miss spelling", () => {
        expect(hasGoneLive("complete")).toBe(false);
        expect(hasGoneLive("Completed")).toBe(false);
    });
});
