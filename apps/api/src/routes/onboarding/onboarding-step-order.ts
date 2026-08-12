import { OnboardingStep } from "@autonoma/db";
import { LIVE_STEP } from "@autonoma/types";
import { z } from "zod";

/**
 * Runtime validator for a step, derived from the Prisma enum rather than re-listing its
 * members. Anything that reads a step from outside the type system - a raw query, an API
 * payload - parses it through this, so a rename in `schema.prisma` propagates instead of
 * leaving a hand-written list behind.
 */
export const OnboardingStepSchema = z.enum(OnboardingStep);

/** Where the current flow starts. Also the safe fallback for a step that cannot be read. */
export const FIRST_ONBOARDING_STEP = OnboardingStep.github;

/**
 * Canonical ordering of the CURRENT onboarding steps - the single source of truth for step
 * sequencing. Every "is this step before/after that one" question goes through
 * {@link isStepAtOrPast} so no caller hand-lists a subset of steps (which would silently
 * rot when the sequence changes).
 *
 * Written in terms of `OnboardingStep.*` rather than string literals, so a step renamed in
 * `schema.prisma` fails to compile here instead of quietly dropping out of the order.
 *
 * The retired steps (`install`, `configure`, `working`, `webhook_configuring`,
 * `discovering`, `discovered`, `dry_run_passed`, `url`) are deliberately absent. An
 * application parked on one has been through none of the flow below, and sorting before
 * everything is what makes the comparison treat it as unfinished rather than as further
 * along than it is.
 *
 * Flow: github (Add app) -> preview_environment ->
 * (previewkit_configuring -> previewkit_deploying | existing_deploys_*) ->
 * preview_verified -> diff_trigger -> completed.
 */
const STEP_ORDER: readonly OnboardingStep[] = [
    FIRST_ONBOARDING_STEP,
    OnboardingStep.preview_environment,
    OnboardingStep.previewkit_configuring,
    OnboardingStep.previewkit_deploying,
    OnboardingStep.existing_deploys_configuring,
    OnboardingStep.existing_deploys_waiting,
    OnboardingStep.preview_verified,
    OnboardingStep.diff_trigger,
    LIVE_STEP,
];

/**
 * Whether `step` is at or past `target` in the onboarding sequence. An unknown step (not in
 * STEP_ORDER, indexOf -1) sorts before every real target.
 *
 * For "is this application live?" use `hasGoneLive` from `@autonoma/types` instead. This
 * answers a different question and only agrees with it while `completed` is last.
 */
export function isStepAtOrPast(step: OnboardingStep, target: OnboardingStep): boolean {
    return STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf(target);
}
