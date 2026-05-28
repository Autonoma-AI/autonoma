import type { ModelMessage } from "ai";
import type { AgentLoop, AgentRunResult } from "./agent-loop";

/**
 * Factory for {@link AgentLoop} instances, holding the immutable configuration and dependencies
 * for an agent. Each call to {@link Agent.run} builds a fresh {@link AgentLoop} via
 * {@link createLoop}; the loop holds all the mutable state of a single run.
 *
 * Subclasses define their own typed `TGenerationInput` / `TResult` / `TLoop` and implement the
 * two protected hooks:
 *
 * - {@link buildUserPrompt} - construct the user prompt from the input. Async, so subclasses can
 *   do pre-loop work (e.g. uploading a video, computing a diff) that the prompt depends on.
 * - {@link createLoop} - build a fresh, per-run {@link AgentLoop} subclass instance carrying any
 *   per-run state and dependencies the tools will consult.
 */
export abstract class Agent<TGenerationInput, TResult, TLoop extends AgentLoop<TResult>> {
    /** Builds the user prompt for the agent from the generation input. */
    protected abstract buildUserPrompt(input: TGenerationInput): Promise<ModelMessage[]>;

    /**
     * Factory method to create a new {@link AgentLoop} instance.
     *
     * The loop holds all the mutable state of a single run, while the Agent class itself is
     * immutable across runs.
     */
    protected abstract createLoop(input: TGenerationInput): Promise<TLoop>;

    /** Runs the agent loop end-to-end and returns the result plus the captured conversation. */
    public async run(input: TGenerationInput): Promise<AgentRunResult<TResult>> {
        const userPrompt = await this.buildUserPrompt(input);
        const loop = await this.createLoop(input);
        return await loop.runLoop(userPrompt);
    }
}
