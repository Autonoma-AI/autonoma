import type { NavigateFn } from "@tanstack/react-router";

const STEP_ROUTES: Record<string, string> = {
    install: "/onboarding/install",
    configure: "/onboarding/configure",
    working: "/onboarding/working",
    scenario_dry_run: "/onboarding/scenario-dry-run",
    url: "/onboarding/url",
};

/**
 * Navigate to the onboarding step that corresponds to the application's current state.
 * The applicationId is passed via search params so each page can read it.
 */
export function navigateToOnboarding(applicationId: string, step: string | undefined, navigate: NavigateFn) {
    const route = STEP_ROUTES[step ?? "install"] ?? "/onboarding/install";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic route requires any cast for search params
    void navigate({ to: route, search: { appId: applicationId } } as any);
}
