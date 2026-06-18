/**
 * Trigger-specific refinement-loop iteration caps. Diffs gets 4 (the folded
 * resolution turn + 3 refinement turns); onboarding stays at 3. This is the
 * single source of truth for the cap - the refinement-loop workflow derives its
 * default from it, and eval-capture reconstructs the cap a frozen iteration ran
 * under from its loop's trigger.
 */
export const REFINEMENT_MAX_ITERATIONS: Readonly<Record<"onboarding" | "diffs", number>> = {
    diffs: 4,
    onboarding: 3,
};

/** The iteration cap for a refinement loop with the given trigger. */
export function maxIterationsForTrigger(triggeredBy: "onboarding" | "diffs"): number {
    return REFINEMENT_MAX_ITERATIONS[triggeredBy];
}
