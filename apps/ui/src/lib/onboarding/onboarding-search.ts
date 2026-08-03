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
    /**
     * Opt out of the coding-agent headline and answer the routing questionnaire
     * yourself. Same shape as `configStep` on the config step: absent means the
     * agent path is the headline, present means "take me to the hands-on flow".
     */
    manual?: boolean;
}

/**
 * Builds the full search object for the `/onboarding` route. Every onboarding
 * navigation must spell out all search keys, so this centralizes the `undefined`
 * defaults and lets call sites pass only the step (and any focus overrides).
 *
 * An undefined `step` means "resume": the route falls back to the application's
 * persisted backend step instead of pinning the view to a requested one.
 */
export function buildOnboardingSearch(
    step: OnboardingStep | undefined,
    appId?: string,
    overrides: OnboardingSearchOverrides = {},
) {
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
        manual: overrides.manual,
    };
}
