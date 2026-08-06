import { agentNow } from "../ui/eta";
import { getActiveStore } from "../ui/store";
import type { StepName } from "./state";

/**
 * The active run's agent-time clock value, or undefined headless. Used as
 * `startedAt` for sub-progress that reports to the ETA model - it is the same
 * clock `StepNode.startedAt` uses, so the two are comparable.
 *
 * The formula itself lives in `ui/eta.ts` as a pure function of the state; this
 * only binds it to the active store, so there is one definition of agent-time.
 */
export function activeAgentNow(): number | undefined {
    const store = getActiveStore();
    if (store == null) return undefined;
    return agentNow(store.getState());
}

/**
 * Report a step's real done/total to the dashboard strip and the ETA model's
 * live-pace layer. The agents' own trackers (pages read, models audited,
 * nodes tested) are the source of truth; this is a no-op headless.
 *
 * `startedAt` is the agent-time clock value when this sub-progress began - used
 * by the ETA model to bridge the gap between a phase starting and its first
 * completion, so a freshly-started pass reads as underway, not 0% / 0 remaining.
 */
export function reportSubProgress(
    step: StepName,
    done: number,
    total: number,
    unit: string,
    note?: string,
    startedAt?: number,
): void {
    if (total <= 0) return;
    getActiveStore()?.setSubProgress(step, { done: Math.min(done, total), total, unit, note, startedAt });
}
