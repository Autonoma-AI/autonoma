import type { OnboardingStep } from "@autonoma/db";

/**
 * Whether an application has finished onboarding (e2e tests generated, preview environment wired up,
 * gone live). Autonoma must not post PR comments on a client's repository until this is true: a
 * half-onboarded app has no meaningful results to report, and commenting early is just noise on the
 * client's PRs. A missing step (no onboarding row) counts as not-onboarded, so we fail closed and stay
 * silent when in doubt.
 */
export function isOnboardingComplete(step: OnboardingStep | null | undefined): boolean {
    return step === "completed";
}
