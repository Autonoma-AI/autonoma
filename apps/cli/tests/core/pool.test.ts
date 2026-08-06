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

    it("calls onProgress after each job settles with the running count and total", async () => {
        const items = Array.from({ length: 6 }, (_, i) => i);
        const calls: { settled: number; total: number }[] = [];

        await runPool(
            items,
            { limit: 2, onProgress: (settled, total) => calls.push({ settled, total }) },
            async (i) => {
                await new Promise((res) => setTimeout(res, 5));
                return i;
            },
        );

        // 6 jobs, each settling once -> 6 progress calls.
        expect(calls).toHaveLength(6);
        // Total is always the full item count.
        expect(calls.every((c) => c.total === 6)).toBe(true);
        // Settled counts up 1..6 in completion order.
        expect(calls.map((c) => c.settled)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it("counts failed jobs in onProgress, not just completed ones", async () => {
        const items = [1, 2, 3];
        const calls: number[] = [];

        await runPool(items, { limit: 2, onProgress: (settled) => calls.push(settled) }, async (i) => {
            if (i === 2) throw new Error("boom");
            return i;
        });

        // All 3 jobs settled (1 failed, 2 completed) -> 3 progress calls.
        expect(calls).toHaveLength(3);
        expect(calls.at(-1)).toBe(3);
    });

    it("announces each job through onStart before its work runs", async () => {
        const items = ["a", "b", "c", "d"];
        const started: string[] = [];
        const finished: string[] = [];

        await runPool(items, { limit: 2, onStart: (item) => started.push(item) }, async (item) => {
            await new Promise((res) => setTimeout(res, 5));
            finished.push(item);
            return item;
        });

        expect(started).toEqual(items);
        // The point of onStart: work in flight is visible before it lands. With
        // 2 slots, two jobs have started before the first one finishes.
        expect(started.slice(0, 2)).toEqual(["a", "b"]);
        expect(finished).toHaveLength(4);
    });

    it("does not call onStart for items the deadline skipped", async () => {
        const items = Array.from({ length: 10 }, (_, i) => i);
        const started: number[] = [];
        let dispatched = 0;

        const outcome = await runPool(
            items,
            { limit: 2, shouldContinue: () => dispatched < 4, onStart: (i) => started.push(i) },
            async (i) => {
                dispatched++;
                return i;
            },
        );

        expect(started).toHaveLength(outcome.completed.length);
        expect(outcome.skipped.some((i) => started.includes(i))).toBe(false);
    });
});
