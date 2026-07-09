import type { Screenshot } from "@autonoma/image";
import type { ModelMessage } from "ai";
import type { CommandParams, CommandSpec } from "../../commands";
import type { AgentExecutionOutput } from "./tools/command-tool";

export type StepMetadata = { screenshot: Screenshot } & Record<string, unknown>;

/**
 * A successful command attempt: parameter extraction and `execute()` both
 * completed without throwing.
 *
 * ! WARNING: Avoid sending this object through the network, since it may contain screenshot data.
 */
export type GeneratedStep<TSpec extends CommandSpec> = {
    /** Discriminant for the {@link StepAttempt} union. */
    status: "success";

    /** The output of the step execution */
    executionOutput: AgentExecutionOutput<TSpec>;

    /** The metadata from before the step execution */
    beforeMetadata: StepMetadata;

    /** The metadata from after the step execution */
    afterMetadata: StepMetadata;
};

/**
 * A failed command attempt: parameter extraction or `execute()` threw (e.g. an
 * assertion that did not hold, a point-detection miss, a driver error). Failed
 * attempts exist to make the agent's botched attempts visible to users and to review.
 *
 * ! WARNING: Avoid sending this object through the network, since it may contain screenshot data.
 */
export type FailedStep<TSpec extends CommandSpec> = {
    /** Discriminant for the {@link StepAttempt} union. */
    status: "failed";

    /** The command that was attempted. */
    interaction: TSpec["interaction"];

    /** The raw tool input the model provided. */
    input: unknown;

    /** The extracted command params - absent if parameter extraction itself threw. */
    params?: CommandParams<TSpec>;

    /** The thrown error's message. */
    error: string;

    /** The thrown error's class name (attribution signal). */
    errorName: string;

    /** The screenshot captured before the attempt (the model's view when it chose the command). */
    beforeMetadata: StepMetadata;

    /**
     * The screenshot captured after the failure. Best-effort: absent if even
     * taking this screenshot failed.
     */
    afterMetadata?: StepMetadata;
};

/**
 * A single command attempt in the full generation timeline, discriminated on
 * `status`. The successful subset is derived by filtering `status === "success"`.
 */
export type StepAttempt<TSpec extends CommandSpec> = GeneratedStep<TSpec> | FailedStep<TSpec>;

export interface ExecutionResult<TSpec extends CommandSpec> {
    /** The results of the steps that were executed */
    generatedSteps: GeneratedStep<TSpec>[];

    /** The final state of the agent's memory (extracted variables) */
    memory: Record<string, string>;

    /** Whether the execution completed successfully */
    success: boolean;

    /** The reason for completion (success, max steps reached, error) */
    finishReason: "success" | "max_steps" | "error";

    /** Reasoning provided by the model when finishing */
    reasoning?: string;

    /** The screenshot taken at the start of the final agent iteration - what the model saw when it decided to finish */
    finalScreenshot?: Screenshot;

    /** Conversation steps from the model */
    conversation: ModelMessage[];
}

export type LeanGeneratedStep<TSpec extends CommandSpec> = Omit<
    GeneratedStep<TSpec>,
    "beforeMetadata" | "afterMetadata"
>;

/**
 * A lean version of the execution result, capable of being serialized and sent over the network.
 *
 * It excludes the before/after metadata from the generated steps, since they contain large images that are not needed for the client.
 */
export type LeanExecutionResult<TSpec extends CommandSpec = CommandSpec> = Omit<
    ExecutionResult<TSpec>,
    "generatedSteps"
> & {
    // Exclude the before/after metadata from the generated steps - They contain large images that are not needed for the client.
    generatedSteps: LeanGeneratedStep<TSpec>[];
};

export function toLeanStep<TSpec extends CommandSpec>({
    beforeMetadata: _beforeMetadata,
    afterMetadata: _afterMetadata,
    ...step
}: GeneratedStep<TSpec>): LeanGeneratedStep<TSpec> {
    return step;
}

export function toLeanResult<TSpec extends CommandSpec>(result: ExecutionResult<TSpec>): LeanExecutionResult<TSpec> {
    return {
        ...result,
        generatedSteps: result.generatedSteps.map(toLeanStep),
    };
}
