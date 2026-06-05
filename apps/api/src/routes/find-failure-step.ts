/**
 * Resolves the step that best represents a failure from an ordered list of step outputs.
 * Prefers the step matching the analysis-reported failure order, falling back to the last step.
 */
export function findFailureStep<T extends { order: number }>(
    steps: T[],
    failureStepOrder: number | undefined,
): T | undefined {
    if (failureStepOrder != null) {
        const matchingStep = steps.find((step) => step.order === failureStepOrder);
        if (matchingStep != null) return matchingStep;
    }
    return steps.at(-1);
}
