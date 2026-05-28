import { type AgentRunResult, MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import { Codebase, DiffsAgent, type DiffsAgentInput, type DiffsAgentResult } from "@autonoma/diffs";
import { logger } from "@autonoma/logger";

interface RunDiffsAgentParams {
    /** Everything the DiffsAgent needs except the codebase clone (which the runner owns). */
    input: Omit<DiffsAgentInput, "codebase">;
    repoDir: string;
}

/**
 * Constructs a {@link DiffsAgent}, wraps the local clone in a {@link Codebase},
 * and invokes {@link DiffsAgent.run}. Owns the model registry so it can log
 * post-run usage metrics for the job.
 */
export async function runDiffsAgent({
    input,
    repoDir,
}: RunDiffsAgentParams): Promise<AgentRunResult<DiffsAgentResult>> {
    const registry = new ModelRegistry({
        models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
    });
    const model = registry.getModel({ model: "flash", tag: "diffs-job" });

    const agent = new DiffsAgent({ model });
    const codebase = new Codebase(repoDir);

    const startTime = Date.now();
    const { result, conversation } = await agent.run({ ...input, codebase });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    logger.info("Diffs analysis complete", {
        elapsed: `${elapsed}s`,
        affectedTests: result.affectedTests.length,
        testCandidates: result.testCandidates.length,
        reasoning: result.reasoning.slice(0, 500),
        modelUsage: registry.modelUsage,
    });

    return { result, conversation };
}
