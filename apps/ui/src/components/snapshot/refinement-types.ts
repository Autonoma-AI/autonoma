import type { SnapshotDetail } from "./diffs-timeline-types";

export type RefinementLoop = NonNullable<SnapshotDetail["refinementLoop"]>;
export type RefinementIteration = RefinementLoop["iterations"][number];
export type RefinementAction = RefinementIteration["actions"][number];
export type IterationOutcomes = RefinementIteration["outcomes"];
export type IterationValidated = IterationOutcomes["validated"][number];
export type IterationFailedAtGeneration = IterationOutcomes["failedAtGeneration"][number];
export type IterationFailedAtReplay = IterationOutcomes["failedAtReplay"][number];

export type IterationVisualState = "pending" | "running" | "validated" | "healed" | "failed" | "no_actions";

export function iterationVisualState(
    iter: RefinementIteration,
    context: { loopStatus?: RefinementLoop["status"]; isLast?: boolean } = {},
): IterationVisualState {
    if (context.loopStatus === "error" && context.isLast === true) return "failed";
    if (iter.status === "pending") return "pending";
    if (iter.status === "running") return "running";
    const hasFailures = iter.outcomes.failedAtGeneration.length > 0 || iter.outcomes.failedAtReplay.length > 0;
    if (!hasFailures) return "validated";
    if (iter.actions.length > 0) return "healed";
    return "no_actions";
}
