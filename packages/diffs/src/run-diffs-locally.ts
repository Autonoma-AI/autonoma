import type { LanguageModel } from "@autonoma/ai";
import { logger as rootLogger } from "@autonoma/logger";
import { DiffsAgent } from "./agents/diffs/diffs-agent";
import type { DiffsAgentResult } from "./agents/diffs/diffs-agent";
import { Codebase } from "./codebase";
import type { ExistingTestInfo } from "./diffs-agent";
import { FlowIndex } from "./flow-index";

export interface LocalDiffsRunnerParams {
    model: LanguageModel;
    repoDir: string;
    baseSha: string;
    headSha: string;
    existingTests: ExistingTestInfo[];
}

/**
 * Local-dev runner for {@link DiffsAgent}. Builds a flat single-flow index
 * and a {@link Codebase} pointing at the provided repository directory, then
 * invokes the agent's {@link DiffsAgent.run} method.
 */
export async function runDiffsAgentLocally(params: LocalDiffsRunnerParams): Promise<DiffsAgentResult> {
    const logger = rootLogger.child({ name: "runDiffsAgentLocally", repoDir: params.repoDir });
    const { model, repoDir, baseSha, headSha, existingTests } = params;

    logger.info("Starting DiffsAgent", { existingTests: existingTests.length });

    const flowIndex = new FlowIndex([
        {
            id: "all",
            name: "All Tests",
            testSlugs: existingTests.map((t) => t.slug),
        },
    ]);

    const codebase = new Codebase(repoDir);
    const agent = new DiffsAgent({ model });

    const { result } = await agent.run({ headSha, baseSha, existingTests, codebase, flowIndex });

    logger.info("Analysis complete", {
        affectedTests: result.affectedTests.length,
        testCandidates: result.testCandidates.length,
    });

    return result;
}
