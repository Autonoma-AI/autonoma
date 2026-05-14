import { logger as rootLogger } from "@autonoma/logger";
import type { LanguageModel } from "ai";
import { DiffsAgent, type ExistingSkillInfo, type ExistingTestInfo } from "./diffs-agent";
import { FlowIndex } from "./flow-index";
import type { DiffsAgentResult } from "./tools/finish-tool";

export interface LocalDiffsRunnerParams {
    model: LanguageModel;
    repoDir: string;
    baseSha: string;
    headSha: string;
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
    maxSteps?: number;
}

export async function runDiffsAgentLocally(params: LocalDiffsRunnerParams): Promise<DiffsAgentResult> {
    const logger = rootLogger.child({ name: "runDiffsAgentLocally", repoDir: params.repoDir });
    const { model, repoDir, baseSha, headSha, existingTests, existingSkills, maxSteps } = params;

    logger.info("Starting DiffsAgent", {
        existingTests: existingTests.length,
        existingSkills: existingSkills.length,
    });

    const flowIndex = new FlowIndex([
        {
            id: "all",
            name: "All Tests",
            testSlugs: existingTests.map((t) => t.slug),
        },
    ]);

    const agent = new DiffsAgent({
        model,
        workingDirectory: repoDir,
        flowIndex,
        maxSteps,
    });

    const result = await agent.analyze({ headSha, baseSha, existingTests, existingSkills });

    logger.info("Analysis complete", {
        affectedTests: result.affectedTests.length,
        testCandidates: result.testCandidates.length,
    });

    return result;
}
