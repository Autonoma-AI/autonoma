import type { OnboardingStep } from "@autonoma/db";

/**
 * Canonical ordering of onboarding steps - the single source of truth for step
 * sequencing. Every "is this step before/after that one" question goes through
 * {@link isStepAtOrPast} so no caller hand-lists a subset of steps (which would
 * silently rot when the sequence changes).
 *
 * Flow: github (Add app) -> preview_environment ->
 * (previewkit_configuring -> previewkit_deploying | existing_deploys_*) ->
 * preview_verified -> diff_trigger -> completed.
 */
const STEP_ORDER: readonly OnboardingStep[] = [
    "github",
    "preview_environment",
    "previewkit_configuring",
    "previewkit_deploying",
    "existing_deploys_configuring",
    "existing_deploys_waiting",
    "preview_verified",
    "diff_trigger",
    "completed",
];

/**
 * Whether `step` is at or past `target` in the onboarding sequence. An unknown
 * step (not in STEP_ORDER, indexOf -1) sorts before every real target.
 */
export function isStepAtOrPast(step: OnboardingStep, target: OnboardingStep): boolean {
    return STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf(target);
}
