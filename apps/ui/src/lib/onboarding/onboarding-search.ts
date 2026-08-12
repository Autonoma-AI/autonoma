import type { ConfigStepId } from "./config-steps";
import type { OnboardingViewStep } from "./onboarding-steps";

type FocusSection = "config" | "secrets" | "logs";

/** Which host tab the existing-deploys step opens on. */
export type OnboardingSignalProvider = "vercel" | "custom";

/** How the user entered onboarding, e.g. redirected from the Vercel marketplace. */
export type OnboardingOrigin = "vercel";

interface OnboardingSearchOverrides {
    error?: string;
    /** GitHub account already connected, when `error` is an install conflict. */
    account?: string;
    /** GitHub account the user tried to add, when `error` is an install conflict. */
    attempted?: string;
    /** GitHub page for the installation the failure's steps tell the user to uninstall. */
    manageUrl?: string;
    apiKey?: string;
    setupId?: string;
    /**
     * The preview the SDK step validated, carried into the dry-run step so both
     * run against the same environment (and survive a refresh). Falls back to the
     * auto-detected default when the target is gone - PR closed, preview torn down.
     */
    target?: string;
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
    step: OnboardingViewStep | undefined,
    appId?: string,
    overrides: OnboardingSearchOverrides = {},
) {
    return {
        step,
        appId,
        error: overrides.error,
        account: overrides.account,
        attempted: overrides.attempted,
        manageUrl: overrides.manageUrl,
        apiKey: overrides.apiKey,
        setupId: overrides.setupId,
        target: overrides.target,
        focusApp: overrides.focusApp,
        focusField: overrides.focusField,
        focusSection: overrides.focusSection,
        configStep: overrides.configStep,
        provider: overrides.provider,
        origin: overrides.origin,
        manual: overrides.manual,
    };
}
