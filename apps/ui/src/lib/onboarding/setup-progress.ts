import { SETUP_STEPS, type SetupStep } from "./onboarding-steps";

/**
 * The post-go-live progress the backend derives for an application. These are
 * flags rather than onboarding steps because going live is what the persisted
 * `step` column records, and it is already `completed` while this work remains.
 */
export interface SetupProgress {
    /** The planner run finished and every artifact - recipe included - landed. */
    artifactsUploaded: boolean;
    /** The environment-factory endpoint answered a discover. */
    sdkConfigured: boolean;
    /** Every provisionable scenario completed an up/down cycle. */
    dryRunPassed: boolean;
}

/**
 * Which flag each setup step is waiting on. Keyed by step so the step list stays
 * the one source of order and nothing can name a step this map has no answer for.
 */
const SETUP_STEP_DONE: Record<SetupStep, (progress: SetupProgress) => boolean> = {
    cli: (progress) => progress.artifactsUploaded,
    sdk: (progress) => progress.sdkConfigured,
    "dry-run": (progress) => progress.dryRunPassed,
};

export function isSetupStepDone(step: SetupStep, progress: SetupProgress): boolean {
    return SETUP_STEP_DONE[step](progress);
}

/** The first setup step still outstanding, or `undefined` once they all are done. */
export function firstIncompleteSetupStep(progress: SetupProgress): SetupStep | undefined {
    return SETUP_STEPS.find((step) => !isSetupStepDone(step, progress));
}

/**
 * Whether the user may sit on `step` right now. A step you have finished stays
 * open so Back works, and the first incomplete one is where the flow wants you -
 * but nothing further, so the dry run can't be opened before the SDK answers.
 */
export function isSetupStepReachable(step: SetupStep, progress: SetupProgress): boolean {
    if (isSetupStepDone(step, progress)) return true;
    return firstIncompleteSetupStep(progress) === step;
}
