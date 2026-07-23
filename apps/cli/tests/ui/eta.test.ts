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

    test("a known page count sizes the page-scaled budgets", () => {
        const store = createStore({ outputDir: "/out", meta: META });
        const flat = computeEta(store.getState()).etaMs;
        // 4 pages: kb 4x25s=100s and tests 4x300s=20min replace the 12min/30min flat budgets.
        store.setSizes({ pages: 4 });
        const sized = computeEta(store.getState()).etaMs;
        expect(sized).toBeLessThan(flat);
        const expected = totalBudgetMs() - STEP_BUDGET.kb.ms - STEP_BUDGET.testGenerator.ms + 4 * 25_000 + 4 * 300_000;
        expect(sized).toBe(expected);
    });

    test("a tiny page count never collapses a sized budget below the floor", () => {
        const store = createStore({ outputDir: "/out", meta: META });
        store.setSizes({ pages: 1 });
        const eta = computeEta(store.getState());
        // kb at 1 page would be 25s; the 90s floor applies.
        const expected = totalBudgetMs() - STEP_BUDGET.kb.ms - STEP_BUDGET.testGenerator.ms + 90_000 + 300_000;
        expect(eta.etaMs).toBe(expected);
    });

    test("the running step's own pace overrides its budget once observed", () => {
        vi.useFakeTimers();
        const store = createStore({ outputDir: "/out", meta: META });
        store.startClock();
        store.startStep("kb");
        vi.advanceTimersByTime(5 * 60_000); // 5 min in...
        store.setSubProgress("kb", { done: 5, total: 20, unit: "pages" }); // ...5 of 20 pages
        const eta = computeEta(store.getState());
        // Live pace: 1 min/page x 15 pages left = ~15 min for kb, plus the
        // other pending budgets untouched (no completed steps -> ratio 1).
        const othersPending = totalBudgetMs() - STEP_BUDGET.kb.ms;
        expect(eta.etaMs - othersPending).toBeGreaterThan(14 * 60_000);
        expect(eta.etaMs - othersPending).toBeLessThan(16 * 60_000);
        store.stopClock();
        vi.useRealTimers();
    });

    test("a run pacing over budget scales the pending agent-paced budgets", () => {
        vi.useFakeTimers();
        const store = createStore({ outputDir: "/out", meta: META });
        store.startClock();
        // projectMapper takes 2x its 3-min budget.
        store.startStep("projectMapper");
        vi.advanceTimersByTime(6 * 60_000);
        store.endStep("projectMapper", "done");
        const eta = computeEta(store.getState());
        // Pending agent-paced budgets double; user-paced ones stay flat.
        const agentPaced = STEP_ORDER.filter((s) => s !== "projectMapper" && STEP_BUDGET[s].maxMs == null).reduce(
            (n, s) => n + STEP_BUDGET[s].ms,
            0,
        );
        const userPaced = STEP_ORDER.filter((s) => STEP_BUDGET[s].maxMs != null).reduce(
            (n, s) => n + STEP_BUDGET[s].ms,
            0,
        );
        expect(eta.etaMs).toBe(agentPaced * 2 + userPaced);
        store.stopClock();
        vi.useRealTimers();
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
