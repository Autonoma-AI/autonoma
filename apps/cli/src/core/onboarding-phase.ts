/**
 * Onboarding steps, in the order the platform advances through them. Mirrors the
 * API's `OnboardingStep` enum and its own step-order module. Deliberately a copy:
 * the CLI is published to npm and cannot import the API's Prisma enum, and the
 * comparison below is written so the copy going stale is safe - a step this list has
 * never heard of sorts before everything, which makes the CLI offer to do the preview
 * work rather than skip work it should have done.
 */
const STEP_ORDER: readonly string[] = [
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

/** The step at which an app's preview environment is up and confirmed. */
const PREVIEW_DONE_STEP = "preview_verified";

/**
 * Where a run should start.
 *
 * - `preview` - the app has no verified preview environment yet, so the run opens by
 *   handing a coding agent the preview setup.
 * - `planner` - the preview is up; run the planner pipeline (knowledge base, scenarios,
 *   SDK handler, tests). This is everything the CLI did before it owned the front door,
 *   and it is where someone who set their preview up by hand lands.
 * - `dryRun` - the planner has already produced and uploaded everything; only the
 *   scenario dry run is outstanding.
 * - `done` - nothing left to do.
 */
export type OnboardingPhase = "preview" | "planner" | "dryRun" | "done";

/**
 * What deciding a phase actually depends on. A structural subset of the onboarding
 * state rather than the whole payload, so the decision has a stated input and can be
 * exercised without standing up an entire API response.
 */
export interface PhaseInputs {
    step: string;
    /** Every artifact the planner produces has landed. */
    artifactsUploaded: boolean;
    /** The SDK endpoint answered a discover. */
    sdkConfigured: boolean;
    /** Every provisionable scenario has completed an up/down cycle. */
    dryRunPassed: boolean;
}

/**
 * Whether `step` is at or past `target` in the onboarding sequence. An unrecognized
 * step (indexOf -1) sorts before every target - see {@link STEP_ORDER}.
 */
export function isStepAtOrPast(step: string, target: string): boolean {
    return STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf(target);
}

/**
 * The first phase of work this app still needs, from the platform's own view of it.
 *
 * Keyed on onboarding state rather than on anything previewkit-specific, so it reads
 * the same whether the preview is Autonoma-hosted, on Vercel, or on the customer's own
 * pipeline: each of those advances the step in its own way, and all this asks is
 * whether the step got there.
 *
 * Ordering matters and is not the same as the order the UI presents things in. The
 * planner phase is what produces the SDK handler AND the artifacts, so it is
 * outstanding while either is missing; only once both have landed is the dry run the
 * one thing left.
 */
export function resolveEntryPhase(state: PhaseInputs): OnboardingPhase {
    if (!isStepAtOrPast(state.step, PREVIEW_DONE_STEP)) return "preview";
    if (!state.artifactsUploaded || !state.sdkConfigured) return "planner";
    if (!state.dryRunPassed) return "dryRun";
    return "done";
}
