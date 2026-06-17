import type { NavigateFn } from "@tanstack/react-router";
import { buildOnboardingSearch } from "./onboarding-search";
import type { OnboardingStep } from "./onboarding-steps";

const STEP_ROUTES: Record<string, OnboardingStep> = {
    install: "cli-setup",
    configure: "cli-setup",
    working: "cli-setup",
    webhook_configuring: "scenario-dry-run",
    discovering: "scenario-dry-run",
    discovered: "scenario-dry-run",
    dry_run_passed: "scenario-dry-run",
    url: "github",
    github: "github",
    preview_environment: "preview-environment",
    previewkit_configuring: "previewkit-config",
    existing_deploys_configuring: "existing-deploys",
    existing_deploys_waiting: "existing-deploys",
    previewkit_deploying: "deploy-verify",
    preview_verified: "deploy-verify",
    completed: "complete",
};

export function navigateToOnboarding(applicationId: string, step: string | undefined, navigate: NavigateFn) {
    const resolvedStep: OnboardingStep = step != null ? (STEP_ROUTES[step] ?? "cli-setup") : "cli-setup";
    void navigate({ to: "/onboarding", search: buildOnboardingSearch(resolvedStep, applicationId) });
}
