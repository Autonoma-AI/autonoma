import { logger, type Logger } from "@autonoma/logger";
import { tool } from "ai";
import type z from "zod";
import type { AgentLoop } from "../agent-loop";
import { FatalToolError, FixableToolError } from "./tool-errors";

/**
 * Error-handling policy for a tool. Governs how unclassified exceptions (those that are neither
 * {@link FixableToolError} nor {@link FatalToolError}) are treated.
 *
 * - `continue_unless_fatal`: continue the loop unless the error is a {@link FatalToolError}. Any
 *   other thrown error becomes a fixable failure delivered to the model. This is the default and
 *   matches the behavior the AI SDK already provides.
 * - `stop_unless_fixable`: stop the loop unless the error is a {@link FixableToolError}. Any other
 *   thrown error is treated as fatal and propagates to the loop caller.
 *
 * In practice, tools should classify their failures explicitly (throwing {@link FixableToolError}
 * with a useful {@link FixableToolError.suggestFix} message, or {@link FatalToolError} for
 * unrecoverable infra failures). This policy is the fallback for anything the tool didn't anticipate.
 */
type ToolErrorHandling = "continue_unless_fatal" | "stop_unless_fixable";

export interface AgentToolParameters<TInput> {
    /** The name of this tool, used by the model to invoke it. */
    name: string;

    /** Agent-readable description of the tool. Surfaces to the model. */
    description: string;

    /** Input schema for this tool, used for validating the input before calling {@link AgentTool.execute}. */
    inputSchema: z.ZodSchema<TInput>;

    /**
     * Error handling policy for the tool. See {@link ToolErrorHandling}.
     *
     * Defaults to `continue_unless_fatal`.
     */
    errorHandling?: ToolErrorHandling;
}

function toolFailure(error: Error, fixSuggestion?: string) {
    return { success: false, error: error.message, fixSuggestion };
}

function toolSuccess<TOutput>(result: TOutput) {
    return { success: true, result };
}

/**
 * Light wrapper around the AI SDK's `Tool` class that implements typed error handling for the
 * agent's tool calls and provides access to the agent loop state via the `loop` parameter of
 * {@link AgentTool.execute}.
 */
export abstract class AgentTool<TInput, TOutput, TLoop extends AgentLoop = AgentLoop> {
    protected readonly logger: Logger;

    public readonly name: string;
    private readonly description: string;
    private readonly errorHandling: ToolErrorHandling;
    private readonly inputSchema: z.ZodSchema<TInput>;

    constructor({ name, description, errorHandling, inputSchema }: AgentToolParameters<TInput>) {
        this.name = name;
        this.description = description;
        this.errorHandling = errorHandling ?? "continue_unless_fatal";
        this.inputSchema = inputSchema;

        this.logger = logger.child({ name: "AgentTool", toolName: this.name });
    }

    /** The main logic of the tool. Must be implemented by subclasses. */
    protected abstract execute(input: TInput, loop: TLoop): Promise<TOutput>;

    /**
     * Convert this tool into an AI-SDK `Tool`. The return type is intentionally inferred (rather
     * than annotated with the broad `Tool` from the SDK) so callers can recover the precise
     * `Tool<TInput, ...>` shape via {@link AgentToolSdkTool}.
     */
    public toTool(loop: TLoop) {
        return tool({
            description: this.description,
            inputSchema: this.inputSchema,
            execute: async (input: TInput) => {
                try {
                    this.logger.info("Executing tool", { input });
                    const result = await this.execute(input, loop);
                    this.logger.info("Tool executed successfully", { result });
                    return toolSuccess(result);
                } catch (error) {
                    if (
                        error instanceof FixableToolError ||
                        (!(error instanceof FatalToolError) && this.errorHandling === "continue_unless_fatal")
                    ) {
                        this.logger.error("Fixable error during tool execution", {
                            error: error instanceof Error ? error.message : String(error),
                        });

                        const fixSuggestion = error instanceof FixableToolError ? error.suggestFix() : undefined;
                        if (fixSuggestion != null) this.logger.info("Suggesting fix for error", { fixSuggestion });

                        return toolFailure(error instanceof Error ? error : new Error(String(error)), fixSuggestion);
                    }

                    this.logger.fatal("Fatal error during tool execution, stopping agent loop", {
                        error: error instanceof Error ? error.message : String(error),
                    });

                    throw error instanceof Error ? error : new Error(String(error));
                }
            },
        });
    }
}

/** Extract the input type of an {@link AgentTool}. */
export type AgentToolInput<T> = T extends AgentTool<infer TInput, unknown> ? TInput : never;

/** Extract the output type of an {@link AgentTool}'s `execute` method (before the success/failure envelope). */
export type AgentToolOutput<T> = T extends AgentTool<unknown, infer TOutput> ? TOutput : never;

/**
 * Extract the AI-SDK `Tool` type produced by an {@link AgentTool}'s {@link AgentTool.toTool}.
 *
 * Useful when callers need to type-thread the SDK-level tool (e.g. when interoperating with the
 * AI SDK's `ToolSet`).
 */
export type AgentToolSdkTool<T> = T extends AgentTool<infer _, infer __> ? ReturnType<T["toTool"]> : never;
