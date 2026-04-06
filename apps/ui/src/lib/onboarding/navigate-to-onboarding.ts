import type { NavigateFn } from "@tanstack/react-router";

const ONBOARDING_APP_KEY = "autonoma.onboarding.applicationId";

const STEP_ROUTES: Record<string, string> = {
    install: "/onboarding/install",
    configure: "/onboarding/configure",
    working: "/onboarding/working",
    scenario_dry_run: "/onboarding/scenario-dry-run",
    url: "/onboarding/url",
};

/**
 * Set the onboarding application ID in localStorage and navigate to the
 * onboarding step that corresponds to the application's current state.
 */
export function navigateToOnboarding(applicationId: string, step: string | undefined, navigate: NavigateFn) {
    localStorage.setItem(ONBOARDING_APP_KEY, applicationId);
    const route = STEP_ROUTES[step ?? "install"] ?? "/onboarding/install";
    void navigate({ to: route });
}
