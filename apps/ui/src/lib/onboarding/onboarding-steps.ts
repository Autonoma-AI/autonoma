export const ONBOARDING_STEPS = [
    "cli-setup",
    "scenario-dry-run",
    "github",
    "preview-environment",
    "previewkit-config",
    "existing-deploys",
    "deploy-verify",
    "complete",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const ONBOARDING_STEP_SET = new Set<string>(ONBOARDING_STEPS);

export function isOnboardingStep(value: string): value is OnboardingStep {
    return ONBOARDING_STEP_SET.has(value);
}
