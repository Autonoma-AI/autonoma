import { MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import { DiffsAgent } from "@autonoma/diffs";
import type { DiffsAgentResult } from "@autonoma/diffs";
import type { DiffsAgentInput } from "@autonoma/diffs";
import type { FlowIndex } from "@autonoma/diffs";
import { logger } from "@autonoma/logger";

interface RunDiffsAgentParams {
    input: DiffsAgentInput;
    repoDir: string;
    flowIndex: FlowIndex;
}

export async function runDiffsAgent({ input, repoDir, flowIndex }: RunDiffsAgentParams): Promise<DiffsAgentResult> {
    const registry = new ModelRegistry({
        models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
    });
    const model = registry.getModel({ model: "flash", tag: "diffs-job" });

    const agent = new DiffsAgent({
        model,
        workingDirectory: repoDir,
        flowIndex,
        maxSteps: 50,
    });

    const startTime = Date.now();
    const result = await agent.analyze(input);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    logger.info("Diffs analysis complete", {
        elapsed: `${elapsed}s`,
        affectedTests: result.affectedTests.length,
        testCandidates: result.testCandidates.length,
        reasoning: result.reasoning.slice(0, 500),
        modelUsage: registry.modelUsage,
    });

    return result;
}
