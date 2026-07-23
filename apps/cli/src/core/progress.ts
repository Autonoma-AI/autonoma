import { getActiveStore } from "../ui/store";
import type { StepName } from "./state";

/**
 * Report a step's real done/total to the dashboard strip and the ETA model's
 * live-pace layer. The agents' own trackers (pages read, models audited,
 * nodes tested) are the source of truth; this is a no-op headless.
 */
export function reportSubProgress(step: StepName, done: number, total: number, unit: string, note?: string): void {
    if (total <= 0) return;
    getActiveStore()?.setSubProgress(step, { done: Math.min(done, total), total, unit, note });
}
