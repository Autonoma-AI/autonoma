import { describe, expect, test, vi } from "vitest";
import { computeEta, formatClock, formatEtaLabel } from "../../src/ui/eta";
import { STEP_BUDGET, STEP_ORDER } from "../../src/ui/steps";
import { createStore } from "../../src/ui/store";

const META = { title: "t", project: "p", version: "0" };

function totalBudgetMs(): number {
    return STEP_ORDER.reduce((n, s) => n + STEP_BUDGET[s].ms, 0);
}

describe("eta model", () => {
    test("fresh run: 0% done, full budget remaining", () => {
        const store = createStore({ outputDir: "/out", meta: META });
        const eta = computeEta(store.getState());
        expect(eta.pct).toBe(0);
        expect(eta.etaMs).toBe(totalBudgetMs());
        expect(eta.complete).toBe(false);
    });

    test("sub-progress drives the running step's fraction", () => {
        const store = createStore({ outputDir: "/out", meta: META });
        store.startStep("projectMapper");
        store.setSubProgress("projectMapper", { done: 1, total: 2, unit: "x" });
        const eta = computeEta(store.getState());
        const expectedConsumed = STEP_BUDGET.projectMapper.ms / 2;
        expect(eta.pct).toBeCloseTo((expectedConsumed / totalBudgetMs()) * 100, 5);
    });

    test("done steps consume their full budget", () => {
        const store = createStore({ outputDir: "/out", meta: META });
        for (const s of STEP_ORDER) store.endStep(s, "done");
        // Steps done but not finished: pct is 100 even before finish() is called.
        expect(computeEta(store.getState()).pct).toBe(100);
    });

    test("finished run reads complete", () => {
        const store = createStore({ outputDir: "/out", meta: META });
        store.finish({ kind: "complete" });
        const eta = computeEta(store.getState());
        expect(eta.complete).toBe(true);
        expect(formatEtaLabel(eta)).toBe("complete");
    });

    test("a failed finish never reads complete or 100%", () => {
        const store = createStore({ outputDir: "/out", meta: META });
        store.endStep("projectMapper", "done");
        store.endStep("pagesFinder", "failed");
        store.finish({ kind: "failed" });
        const eta = computeEta(store.getState());
        expect(eta.complete).toBe(false);
        expect(eta.pct).toBeLessThan(100);
    });

    test("a running user-paced step never collapses to zero remaining", () => {
        const store = createStore({ outputDir: "/out", meta: META });
        for (const s of STEP_ORDER) {
            if (s !== "recipeBuilder" && s !== "testGenerator") store.endStep(s, "done");
        }
        store.startStep("recipeBuilder");
        store.setSubProgress("recipeBuilder", { done: 35, total: 35, unit: "entities" });
        const eta = computeEta(store.getState());
        expect(eta.etaMs).toBeGreaterThanOrEqual(30_000);
    });

    test("formatClock renders mm:ss then h:mm:ss", () => {
        expect(formatClock(65_000)).toBe("01:05");
        expect(formatClock(3_723_000)).toBe("1:02:03");
    });

    test("formatEtaLabel is a single value, no ranges", () => {
        const store = createStore({ outputDir: "/out", meta: META });
        const label = formatEtaLabel(computeEta(store.getState()));
        expect(label).toMatch(/^~.+left$/);
        expect(label).not.toContain("-");
    });
});

describe("wall vs agent time", () => {
    test("time spent blocked on a question is excluded from elapsed", async () => {
        vi.useFakeTimers();
        const store = createStore({ outputDir: "/out", meta: META });
        store.startClock();
        store.startStep("projectMapper");
        vi.advanceTimersByTime(10_000); // 10s of real agent work

        const pending = store.requestPrompt({ kind: "confirm", message: "?" });
        vi.advanceTimersByTime(60_000); // user thinks for a minute
        // While waiting, the clock holds still.
        expect(computeEta(store.getState()).elapsedMs).toBeLessThan(12_000);

        store.submitPrompt();
        await pending;
        vi.advanceTimersByTime(5_000); // 5 more seconds of agent work

        const elapsed = computeEta(store.getState()).elapsedMs;
        expect(elapsed).toBeGreaterThanOrEqual(14_000);
        expect(elapsed).toBeLessThan(20_000);
        store.stopClock();
        vi.useRealTimers();
    });
});
