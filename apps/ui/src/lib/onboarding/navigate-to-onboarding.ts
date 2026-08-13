import type { NavigateFn } from "@tanstack/react-router";
import { resolveStep } from "./onboarding-flow";
import { buildOnboardingSearch } from "./onboarding-search";

/** Search object that resumes an application's onboarding at the step it left off. */
export function buildResumeSearch(step: string | undefined, applicationId: string) {
    return buildOnboardingSearch(resolveStep(step), applicationId);
}

export function navigateToOnboarding(applicationId: string, step: string | undefined, navigate: NavigateFn) {
    void navigate({ to: "/onboarding", search: buildResumeSearch(step, applicationId) });
}
