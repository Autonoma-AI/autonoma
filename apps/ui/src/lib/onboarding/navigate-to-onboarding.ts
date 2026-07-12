import type { NavigateFn } from "@tanstack/react-router";
import { buildOnboardingSearch } from "./onboarding-search";
import type { OnboardingStep } from "./onboarding-steps";

const STEP_ROUTES: Record<string, OnboardingStep> = {
    // "Add app" merges repo connect + app naming, and is the first required step.
    github: "add-app",
    preview_environment: "preview-environment",
    previewkit_configuring: "previewkit-config",
    existing_deploys_configuring: "existing-deploys",
    existing_deploys_waiting: "existing-deploys",
    previewkit_deploying: "deploy-verify",
    preview_verified: "deploy-verify",
    diff_trigger: "diff-trigger",
    completed: "complete",
    // Legacy SDK/CLI steps moved out of the required path: send them to the start.
    install: "add-app",
    configure: "add-app",
    working: "add-app",
    webhook_configuring: "add-app",
    discovering: "add-app",
    discovered: "add-app",
    dry_run_passed: "add-app",
    url: "add-app",
};

/** Maps a backend onboarding step to the UI step it resumes at, defaulting to the first step. */
export function resolveStep(step: string | undefined): OnboardingStep {
    return step != null ? (STEP_ROUTES[step] ?? "add-app") : "add-app";
}

/** Search object that resumes an application's onboarding at the step it left off. */
export function buildResumeSearch(step: string | undefined, applicationId: string) {
    return buildOnboardingSearch(resolveStep(step), applicationId);
}

export function navigateToOnboarding(applicationId: string, step: string | undefined, navigate: NavigateFn) {
    void navigate({ to: "/onboarding", search: buildResumeSearch(step, applicationId) });
}
