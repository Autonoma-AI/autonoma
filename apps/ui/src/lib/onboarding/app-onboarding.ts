import { hasGoneLive } from "@autonoma/types";

/** An application as the app list carries it: onboarding state is absent for legacy apps. */
interface AppWithOnboardingState {
    onboardingState?: { step: string } | null;
}

/**
 * Whether this application is still being set up, and so belongs in the "resume setup"
 * group rather than the usable one.
 *
 * This is deliberately NOT `!hasGoneLive(step)`. The shared predicate fails closed
 * - an application with no onboarding row is not live - because every backend caller is
 * about to write to a customer's repository and must stay quiet when in doubt. The app
 * list asks a different question, and for it a missing row means a legacy application that
 * predates onboarding, which is perfectly usable and must not be shown as unfinished.
 *
 * The two used to share the name `isOnboardingComplete` while meaning opposite things, which
 * is why the shared one is now named for what it actually answers.
 */
export function isMidOnboarding(app: AppWithOnboardingState): boolean {
    if (app.onboardingState == null) return false;
    return !hasGoneLive(app.onboardingState.step);
}
