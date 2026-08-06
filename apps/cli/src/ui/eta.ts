import { STEP_PAGE_SIZING } from "./steps";
import type { ProjectSizes, RunState, StepNode } from "./types";

export interface EtaResult {
    elapsedMs: number;
    /** Remaining time using the lower budget bound. */
    etaMs: number;
    /** 0-100, budget-weighted completion. */
    pct: number;
    complete: boolean;
}

/**
 * A running step always has this much budget left, and so can never read as
 * fully consumed. Sub-progress measures one thing a step does, not everything:
 * the tests step reports N/N nodes and then runs journey generation and up to 45
 * minutes of review cycles.
 */
const RUNNING_MIN_REMAINING_MS = 30_000;
/** Trust the running step's own pace once this much of it is observed. */
const LIVE_RATE_MIN_DONE = 3;
const LIVE_RATE_MIN_ELAPSED_MS = 60_000;
/** Bounds on the completed-steps pace ratio applied to pending budgets. */
const PACE_RATIO_MIN = 0.5;
const PACE_RATIO_MAX = 2;
/** Below this much completed budget, the pace ratio is noise - use 1. */
const PACE_RATIO_MIN_SIGNAL_MS = 120_000;

/**
 * The run's clock excluding time spent blocked on user questions: while a
 * prompt is up (and for all past prompts) the elapsed/ETA hold still.
 */
export function agentNow(state: RunState): number {
    const waitingNow =
        state.prompt.current != null && state.prompt.waitingSince != null
            ? Math.max(0, state.now - state.prompt.waitingSince)
            : 0;
    return state.now - state.waitedMs - waitingNow;
}

function clamp01(n: number): number {
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

/** A step's budget: sized by the known page count where duration scales with
 * it, the flat measured median otherwise. */
function budgetFor(step: StepNode, sizes: ProjectSizes): number {
    const sizing = STEP_PAGE_SIZING[step.name];
    if (sizing == null || sizes.pages == null || sizes.pages <= 0) return step.budgetMs;
    return sizing.baseMs + sizing.msPerPage * Math.min(sizes.pages, sizing.kneePages);
}

/** How "done" a running step is: real sub-progress when we have it, else time. */
function runningFraction(step: StepNode, now: number, budget: number): number {
    if (step.sub && step.sub.total > 0) {
        // A sub-progress that has started but not yet completed its first unit
        // reads as 0% to a pure ratio, even though work is visibly underway. A
        // time-based fallback bridges that gap: it is bounded by the step's own
        // reserve so it can never overshoot what the ratio would reach, and is
        // abandoned the moment the first completion arrives.
        if (step.sub.done === 0 && step.sub.startedAt != null) {
            const elapsed = now - step.sub.startedAt;
            const unspendable = Math.min(budget, RUNNING_MIN_REMAINING_MS);
            return clamp01((budget - unspendable) * (elapsed / budget));
        }
        return clamp01(step.sub.done / step.sub.total);
    }
    if (step.startedAt != null) {
        return clamp01((now - step.startedAt) / budget);
    }
    return 0;
}

/**
 * The running step's own observed pace: elapsed / units-done projects the
 * remaining units. The strongest signal there is - it prices THIS repo on
 * THIS machine - so once enough of the step is observed it overrides the
 * budget-based remainder.
 *
 * When `done` is zero but `startedAt` is present (the review pass just
 * started), there is no per-unit pace yet, so the budget-based remainder
 * takes over - which, thanks to RUNNING_MIN_REMAINING_MS, keeps a floor
 * under the ETA instead of collapsing to zero.
 */
function liveRemainingMs(step: StepNode, now: number): number | undefined {
    if (step.sub == null || step.sub.total <= 0 || step.startedAt == null) return undefined;
    if (step.sub.done < LIVE_RATE_MIN_DONE) return undefined;
    const elapsed = now - step.startedAt;
    if (elapsed < LIVE_RATE_MIN_ELAPSED_MS) return undefined;
    return (elapsed / step.sub.done) * Math.max(0, step.sub.total - step.sub.done);
}

/**
 * How this run is pacing against its budgets, from the steps already
 * completed - a slow machine or a heavyweight repo shows up here. Applied to
 * pending agent-paced budgets; user-paced steps are excluded on both sides
 * (their duration reflects the human/coding agent, not this run's pace).
 */
function paceRatio(state: RunState): number {
    let actual = 0;
    let budgeted = 0;
    for (const name of state.stepOrder) {
        const step = state.steps[name];
        if (step.status !== "done" || step.userPaced) continue;
        if (step.startedAt == null || step.endedAt == null) continue;
        actual += Math.max(0, step.endedAt - step.startedAt);
        budgeted += budgetFor(step, state.sizes);
    }
    if (budgeted < PACE_RATIO_MIN_SIGNAL_MS) return 1;
    return Math.max(PACE_RATIO_MIN, Math.min(PACE_RATIO_MAX, actual / budgeted));
}

/**
 * ETA = sum of remaining step budgets, where a budget is sized by the page
 * count once known, the running step is projected from its own observed pace,
 * and pending steps are scaled by how the run is pacing so far. A single
 * value - no ranges (design decision).
 */
export function computeEta(state: RunState): EtaResult {
    const nowAgent = agentNow(state);
    const elapsedMs = Math.max(0, nowAgent - state.startedAt);

    // Only a successful finish is "complete": a failed or paused run keeps its
    // real budget-weighted percentage instead of jumping to a green 100%.
    if (state.finished && (state.outcome?.kind ?? "complete") === "complete") {
        return { elapsedMs, etaMs: 0, pct: 100, complete: true };
    }

    const ratio = paceRatio(state);
    let consumedBudget = 0;
    let totalBudget = 0;
    let remaining = 0;

    for (const name of state.stepOrder) {
        const step = state.steps[name];
        const budget = budgetFor(step, state.sizes);
        totalBudget += budget;

        if (step.status === "done") {
            consumedBudget += budget;
            continue;
        }

        if (step.status === "running") {
            const frac = runningFraction(step, nowAgent, budget);
            // Both sides floor on the same reserve, so the percentage and the
            // remainder cannot disagree about whether the step is finished.
            const unspendable = Math.min(budget, RUNNING_MIN_REMAINING_MS);
            consumedBudget += Math.min(budget * frac, budget - unspendable);
            const rem = liveRemainingMs(step, nowAgent) ?? budget * (1 - frac);
            remaining += Math.max(rem, unspendable);
            continue;
        }

        // pending / failed / paused - full budget still ahead, scaled by the
        // run's observed pace (user-paced steps keep their flat budget).
        remaining += step.userPaced ? budget : budget * ratio;
    }

    const pct = totalBudget > 0 ? clamp01(consumedBudget / totalBudget) * 100 : 0;

    return { elapsedMs, etaMs: remaining, pct, complete: false };
}

/** mm:ss, or h:mm:ss past an hour. */
export function formatClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Human "~39 min left" / "~1h 5m left". A single value - no range. */
export function formatEtaLabel(eta: EtaResult): string {
    if (eta.complete) return "complete";
    return `~${phrase(Math.max(1, Math.round(eta.etaMs / 60_000)))} left`;
}

function phrase(min: number): string {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
