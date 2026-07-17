import type { ConfigStepId } from "./config-steps";
import type { OnboardingStep } from "./onboarding-steps";

type FocusSection = "config" | "secrets" | "logs";

/** Which host tab the existing-deploys step opens on. */
export type OnboardingSignalProvider = "vercel" | "custom";

/** How the user entered onboarding, e.g. redirected from the Vercel marketplace. */
export type OnboardingOrigin = "vercel";

interface OnboardingSearchOverrides {
    error?: string;
    apiKey?: string;
    setupId?: string;
    focusApp?: string;
    focusField?: string;
    focusSection?: FocusSection;
    /** Active sub-step of the PreviewKit config step, so the sidebar can reflect it. */
    configStep?: ConfigStepId;
    /** Pre-selected provider tab for the existing-deploys step, carried from the routing quiz. */
    provider?: OnboardingSignalProvider;
    /** Where the user came from; "vercel" streamlines the preview-provider steps. */
    origin?: OnboardingOrigin;
}

/**
 * Builds the full search object for the `/onboarding` route. Every onboarding
 * navigation must spell out all search keys, so this centralizes the `undefined`
 * defaults and lets call sites pass only the step (and any focus overrides).
 */
export function buildOnboardingSearch(step: OnboardingStep, appId?: string, overrides: OnboardingSearchOverrides = {}) {
    return {
        step,
        appId,
        error: overrides.error,
        apiKey: overrides.apiKey,
        setupId: overrides.setupId,
        focusApp: overrides.focusApp,
        focusField: overrides.focusField,
        focusSection: overrides.focusSection,
        configStep: overrides.configStep,
        provider: overrides.provider,
        origin: overrides.origin,
    };
}
