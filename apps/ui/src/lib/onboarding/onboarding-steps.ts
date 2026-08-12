/**
 * The screens the onboarding wizard shows, which are NOT the backend's onboarding steps.
 *
 * Several backend steps collapse onto one screen (`previewkit_deploying` and
 * `preview_verified` both render `deploy-verify`), so this is a view concern with its own
 * vocabulary. `mapBackendStepToViewStep` in `onboarding/route.tsx` is the translation.
 * The backend's own union is `OnboardingStep` from `@autonoma/types`; both used to be
 * called `OnboardingStep` and were in scope together in that same file.
 */
export const ONBOARDING_VIEW_STEPS = [
    "add-app",
    "preview-environment",
    "previewkit-config",
    "existing-deploys",
    "deploy-verify",
    "diff-trigger",
    "cli",
    "sdk",
    "dry-run",
    "complete",
] as const;

export type OnboardingViewStep = (typeof ONBOARDING_VIEW_STEPS)[number];

const ONBOARDING_VIEW_STEP_SET = new Set<string>(ONBOARDING_VIEW_STEPS);

export function isOnboardingViewStep(value: string): value is OnboardingViewStep {
    return ONBOARDING_VIEW_STEP_SET.has(value);
}

/**
 * The steps that run after go-live, in the order they must be done: the planner
 * upload lands the recipe a dry run provisions from, and the dry run needs an SDK
 * endpoint to call. Ordering is load-bearing, not presentational.
 */
export const SETUP_STEPS = ["cli", "sdk", "dry-run"] as const satisfies readonly OnboardingViewStep[];

export type SetupStep = (typeof SETUP_STEPS)[number];

const SETUP_STEP_SET: ReadonlySet<string> = new Set<string>(SETUP_STEPS);

export function isSetupStep(value: string): value is SetupStep {
    return SETUP_STEP_SET.has(value);
}
