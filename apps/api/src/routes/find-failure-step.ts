/**
 * Resolves the step that best represents a failure from an ordered list of step outputs.
 *
 * - No reported failure order: fall back to the last executed step.
 * - A reported order matching a real step: that step is the failure.
 * - A reported order with no matching step (a stale or over-counted analysis that
 *   names a step which never executed): return undefined rather than silently
 *   blaming the last step - its screenshot is often a post-navigation/refresh
 *   transient (a blank mid-reload frame). Callers then fall back to the settled
 *   final screenshot, which reflects the real end state.
 */
export function findFailureStep<T extends { order: number }>(
    steps: T[],
    failureStepOrder: number | undefined,
): T | undefined {
    if (failureStepOrder == null) return steps.at(-1);
    return steps.find((step) => step.order === failureStepOrder);
}
