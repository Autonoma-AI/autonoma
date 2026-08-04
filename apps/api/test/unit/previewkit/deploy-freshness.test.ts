import { describe, expect, it } from "vitest";
import { deployFreshness } from "../../../src/previewkit/deploy-freshness";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function hoursAgo(hours: number): Date {
    return new Date(NOW.getTime() - hours * HOUR);
}

describe("deployFreshness", () => {
    it("flags a ready preview whose deploy is old enough to have been torn down", () => {
        const freshness = deployFreshness({ status: "ready", deployedAt: hoursAgo(18 * 24), now: NOW });

        expect(freshness.stale).toBe(true);
        expect(freshness.ageHours).toBe(18 * 24);
        // The note has to separate this from the documented cold start, which an agent is
        // otherwise told to wait out - here there may be nothing left to wake.
        expect(freshness.note).toContain("18 days");
        expect(freshness.note).toContain("404");
    });

    it("leaves a recent deploy alone, with no note to reason about", () => {
        const freshness = deployFreshness({ status: "ready", deployedAt: hoursAgo(3), now: NOW });

        expect(freshness.stale).toBe(false);
        expect(freshness.ageHours).toBe(3);
        expect(freshness.note).toBeUndefined();
    });

    it("does not call a failed deploy stale, however old - its status already says not to trust it", () => {
        const freshness = deployFreshness({ status: "failed", deployedAt: hoursAgo(40 * 24), now: NOW });

        expect(freshness.stale).toBe(false);
        expect(freshness.note).toBeUndefined();
    });

    it("says so when a ready environment has no completed deploy behind it at all", () => {
        const freshness = deployFreshness({ status: "ready", now: NOW });

        expect(freshness.stale).toBe(false);
        expect(freshness.ageHours).toBeUndefined();
        expect(freshness.note).toContain("no completed deploy");
    });
});
