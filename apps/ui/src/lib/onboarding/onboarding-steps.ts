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
    "complete",
] as const;

export type OnboardingViewStep = (typeof ONBOARDING_VIEW_STEPS)[number];

const ONBOARDING_VIEW_STEP_SET = new Set<string>(ONBOARDING_VIEW_STEPS);

export function isOnboardingViewStep(value: string): value is OnboardingViewStep {
    return ONBOARDING_VIEW_STEP_SET.has(value);
}
