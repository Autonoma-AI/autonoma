import { describe, expect, it } from "vitest";
import { findFailureStep } from "../../src/routes/find-failure-step";

const steps = [{ order: 1 }, { order: 2 }, { order: 3 }];

describe("findFailureStep", () => {
    it("returns the step matching the reported failure order", () => {
        expect(findFailureStep(steps, 2)).toEqual({ order: 2 });
    });

    it("falls back to the last step when no failure order is reported", () => {
        expect(findFailureStep(steps, undefined)).toEqual({ order: 3 });
    });

    it("returns undefined for an out-of-range order (stale/over-counted analysis) so callers use the settled final screenshot", () => {
        // The repro: analysis reported step 6 but only 5 steps ran; blaming the
        // last step surfaced a blank post-refresh frame as the hero.
        expect(findFailureStep(steps, 6)).toBeUndefined();
    });

    it("returns undefined when there are no steps", () => {
        expect(findFailureStep([], 1)).toBeUndefined();
        expect(findFailureStep([], undefined)).toBeUndefined();
    });
});
