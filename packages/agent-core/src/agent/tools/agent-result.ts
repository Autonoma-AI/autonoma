import type z from "zod";
import type { AgentLoop } from "../agent-loop";
import { AgentTool } from "./agent-tool";

/**
 * Terminal tool that reports the agent's execution result. When the model invokes this tool, the
 * loop captures the produced result, finishes, and returns it to the caller.
 *
 * `TInput` is the schema the agent must satisfy to finish (typically a "reasoning" field plus
 * whatever else the agent's contract requires). `TResult` is what the caller of the agent loop
 * actually gets back - which may include additional state derived from the loop (e.g. an action
 * collector built up across earlier tool calls).
 */
export abstract class ReportResultTool<
    TInput,
    TResult,
    TLoop extends AgentLoop<TResult> = AgentLoop<TResult>,
> extends AgentTool<TInput, { finished: true }, TLoop> {
    abstract buildResult(input: TInput, loop: TLoop): Promise<TResult>;

    async execute(input: TInput, loop: TLoop): Promise<{ finished: true }> {
        const result = await this.buildResult(input, loop);
        loop.setResult(result);
        return { finished: true };
    }
}

export interface FinishToolParameters<TResult> {
    /** The name of the finish tool. Defaults to "finish". */
    name?: string;

    /** The description of the finish tool. Defaults to a generic "report the result" string. */
    description?: string;

    /** The input schema for the finish tool. */
    resultSchema: z.ZodSchema<TResult>;
}

/**
 * Simple finish tool: takes the final result as input and returns it as-is.
 *
 * Use for agents whose result is fully expressible by the model's final tool call - i.e. no
 * additional state needs to be merged in from the loop. For agents that accumulate a collector
 * across earlier tool calls, extend {@link ReportResultTool} directly so `buildResult` can read
 * the loop state.
 */
export class FinishTool<TResult> extends ReportResultTool<TResult, TResult> {
    constructor({ name, description, resultSchema }: FinishToolParameters<TResult>) {
        super({
            name: name ?? "finish",
            description: description ?? "Finish the agent execution and report the result.",
            inputSchema: resultSchema,
        });
    }

    async buildResult(input: TResult): Promise<TResult> {
        return input;
    }
}
