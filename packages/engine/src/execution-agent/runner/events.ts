import type { CommandSpec } from "../../commands";
import type { ExecutionState, StepAttempt } from "../agent";

export interface CurrentStepData {
    name: string;
    input: unknown;
}

interface BeforeStepData<TSpec extends CommandSpec> {
    state: ExecutionState<TSpec>;
}

/** Payload for a single command attempt, fired for both successes and failures. */
export interface AttemptData<TSpec extends CommandSpec> {
    /** The attempt that just happened (success or failure). */
    attempt: StepAttempt<TSpec>;

    /** 1-based position in the full attempt timeline (counts failures). */
    order: number;

    /** 1-based position in the successful-only step list. Present only for successful attempts. */
    successfulOrder?: number;
}

/** Events emitted by the headless runner */
export interface RunnerEventHandlers<TSpec extends CommandSpec> {
    /** Emitted before a step is executed */
    beforeStep: (beforeStepData: BeforeStepData<TSpec>) => Promise<void>;
    /** Emitted after each command attempt (success or failure) */
    attempt: (attemptData: AttemptData<TSpec>) => Promise<void>;
    /** Emitted when a frame is captured */
    frame: (base64Image: string) => Promise<void>;
}
