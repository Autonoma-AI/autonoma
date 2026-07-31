import { describe, expect, it } from "vitest";
import { runPool } from "../../src/core/pool";

/** Resolve after `ms`, recording concurrency as observed by the caller. */
function tracker() {
    let inFlight = 0;
    let peak = 0;
    return {
        get peak() {
            return peak;
        },
        async run<T>(ms: number, value: T): Promise<T> {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((res) => setTimeout(res, ms));
            inFlight--;
            return value;
        },
    };
}

describe("runPool", () => {
    it("never exceeds the concurrency limit", async () => {
        const t = tracker();
        const items = Array.from({ length: 20 }, (_, i) => i);

        await runPool(items, { limit: 4 }, (i) => t.run(5, i));

        expect(t.peak).toBeLessThanOrEqual(4);
    });

    it("returns a result for every item", async () => {
        const items = ["a", "b", "c", "d", "e"];

        const outcome = await runPool(items, { limit: 2 }, async (item) => item.toUpperCase());

        expect(outcome.completed.map((c) => c.result).sort()).toEqual(["A", "B", "C", "D", "E"]);
        expect(outcome.failed).toEqual([]);
        expect(outcome.skipped).toEqual([]);
    });

    it("refills a slot as soon as one job settles, rather than waiting for the wave", async () => {
        // One very slow job among fast ones. Under batching (limit-sized waves
        // awaited together) the fast jobs behind it would be blocked and the run
        // would take about one slow job per wave; a pool overlaps them.
        const durations = [200, 10, 10, 10, 10, 10, 10, 10, 10];
        const started = Date.now();

        await runPool(durations, { limit: 3 }, (ms) => new Promise((res) => setTimeout(res, ms)));

        // 8 fast jobs over 2 free slots is ~40ms of work, all of it overlapping
        // the single 200ms job. A batching scheduler would serialise the waves.
        expect(Date.now() - started).toBeLessThan(320);
    });

    it("records a throwing job as failed and keeps the rest running", async () => {
        const items = [1, 2, 3, 4];

        const outcome = await runPool(items, { limit: 2 }, async (i) => {
            if (i === 2) throw new Error("boom");
            return i * 10;
        });

        expect(outcome.completed.map((c) => c.result).sort((a, b) => a - b)).toEqual([10, 30, 40]);
        expect(outcome.failed).toHaveLength(1);
        expect(outcome.failed[0]?.item).toBe(2);
    });

    it("stops dispatching when shouldContinue goes false, but finishes what is in flight", async () => {
        const items = Array.from({ length: 10 }, (_, i) => i);
        let dispatched = 0;

        const outcome = await runPool(items, { limit: 2, shouldContinue: () => dispatched < 4 }, async (i) => {
            dispatched++;
            return i;
        });

        expect(outcome.skipped.length).toBeGreaterThan(0);
        expect(outcome.completed.length + outcome.skipped.length).toBe(items.length);
        // Nothing dispatched is abandoned - every started job reported back.
        expect(outcome.completed.length).toBe(dispatched);
    });

    it("treats a limit below 1 as 1 rather than deadlocking", async () => {
        const outcome = await runPool([1, 2, 3], { limit: 0 }, async (i) => i);

        expect(outcome.completed).toHaveLength(3);
    });
});
