import type { RunState, StepNode } from "./types";

export interface EtaResult {
    elapsedMs: number;
    /** Remaining time using the lower budget bound. */
    etaMs: number;
    /** 0-100, budget-weighted completion. */
    pct: number;
    complete: boolean;
}

/** Floors so a user-paced step never collapses the ETA to "0 min left" mid-step. */
const USER_PACED_MIN_REMAINING_MS = 30_000;

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

/** How "done" a running step is: real sub-progress when we have it, else time. */
function runningFraction(step: StepNode, now: number): number {
    if (step.sub && step.sub.total > 0) {
        return clamp01(step.sub.done / step.sub.total);
    }
    if (step.startedAt != null) {
        return clamp01((now - step.startedAt) / step.budgetMs);
    }
    return 0;
}

/**
 * ETA = sum of remaining step budgets, interpolating the running step by its
 * sub-progress (or elapsed time). A single value - no ranges (design decision).
 */
export function computeEta(state: RunState): EtaResult {
    const nowAgent = agentNow(state);
    const elapsedMs = Math.max(0, nowAgent - state.startedAt);

    // Only a successful finish is "complete": a failed or paused run keeps its
    // real budget-weighted percentage instead of jumping to a green 100%.
    if (state.finished && (state.outcome?.kind ?? "complete") === "complete") {
        return { elapsedMs, etaMs: 0, pct: 100, complete: true };
    }

    let consumedBudget = 0;
    let totalBudget = 0;
    let remaining = 0;

    for (const name of state.stepOrder) {
        const step = state.steps[name];
        const budget = step.budgetMs;
        totalBudget += budget;

        if (step.status === "done") {
            consumedBudget += budget;
            continue;
        }

        if (step.status === "running") {
            const frac = runningFraction(step, nowAgent);
            consumedBudget += budget * frac;
            let rem = budget * (1 - frac);
            if (step.budgetMaxMs != null) rem = Math.max(rem, USER_PACED_MIN_REMAINING_MS);
            remaining += rem;
            continue;
        }

        // pending / failed / paused - full budget still ahead
        remaining += budget;
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
