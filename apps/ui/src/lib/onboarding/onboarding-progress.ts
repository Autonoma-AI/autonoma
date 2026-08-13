import { ONBOARDING_PHASES, resolveStep } from "./onboarding-flow";

/**
 * Resolves how far an application is through onboarding for the resume hub,
 * using the same phases the onboarding flow shows: how many phases are done,
 * the total, a percentage, and the name of the phase to do next.
 */
export function getOnboardingProgress(step: string | undefined) {
    const uiStep = resolveStep(step);
    const total = ONBOARDING_PHASES.length;
    const currentIndex = ONBOARDING_PHASES.findIndex((phase) => phase.activeSteps.includes(uiStep));
    const completed = currentIndex < 0 ? total : currentIndex;
    const nextPhase = ONBOARDING_PHASES[completed];

    return {
        completed,
        total,
        percent: Math.round((completed / total) * 100),
        nextStep: nextPhase?.label ?? "Finish",
    };
}
