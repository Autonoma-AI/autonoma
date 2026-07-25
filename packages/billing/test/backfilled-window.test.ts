import { describe, expect, test } from "vitest";
import { isBackfilledWindow } from "../src/preview-usage-meter/preview-usage-meter-sweep.service";

// The sweep closes windows up to floor(now - 5min ingestion lag). At 00:03 that newest
// closable window is the one ending 23:45 - the live edge, where a fleet-wide empty
// result means the scrape pipeline stopped rather than that the history is missing.
const NOW = new Date("2026-07-22T00:03:00.000Z");
const LIVE_EDGE = new Date("2026-07-21T23:45:00.000Z");

describe("isBackfilledWindow", () => {
    test("treats the newest closable window as live, so its emptiness escalates", () => {
        expect(isBackfilledWindow(LIVE_EDGE, NOW)).toBe(false);
    });

    test("treats an older window as backfilled", () => {
        expect(isBackfilledWindow(new Date(LIVE_EDGE.getTime() - 15 * 60 * 1000), NOW)).toBe(true);
    });
});
