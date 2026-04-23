import type { NavigateFn } from "@tanstack/react-router";
import type { OnboardingStep } from "./onboarding-steps";

const STEP_ROUTES: Record<string, OnboardingStep> = {
    install: "install",
    configure: "install",
    working: "working",
    webhook_configuring: "scenario-dry-run",
    discovering: "scenario-dry-run",
    discovered: "scenario-dry-run",
    dry_run_passed: "scenario-dry-run",
    url: "scenario-dry-run",
    github: "github",
    completed: "complete",
};

/**
 * Navigate to the onboarding step that corresponds to the application's current state.
 * The applicationId is passed via search params so each page can read it.
 */
export function navigateToOnboarding(applicationId: string, step: string | undefined, navigate: NavigateFn) {
    const resolvedStep: OnboardingStep = STEP_ROUTES[step ?? "install"] ?? "intro-welcome";
    void navigate({ to: "/onboarding", search: { step: resolvedStep, appId: applicationId } });
}
