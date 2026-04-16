import { logger as rootLogger } from "@autonoma/logger";
import type { LanguageModel } from "ai";
import type { ExistingSkillInfo, ExistingTestInfo } from "./diffs-agent";
import { FlowIndex } from "./flow-index";
import {
    ResolutionAgent,
    type ResolutionAgentResult,
    type RunReviewVerdict,
    type TestCandidateInput,
} from "./resolution-agent";
import type { TestDirectory } from "./test-directory";

export interface LocalResolutionRunnerParams {
    model: LanguageModel;
    repoDir: string;
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
    testDirectory: TestDirectory;
    verdicts: RunReviewVerdict[];
    step1Reasoning: string;
    testCandidates: TestCandidateInput[];
    maxSteps?: number;
}

export async function runResolutionAgentLocally(params: LocalResolutionRunnerParams): Promise<ResolutionAgentResult> {
    const logger = rootLogger.child({ name: "runResolutionAgentLocally", repoDir: params.repoDir });
    const {
        model,
        repoDir,
        existingTests,
        existingSkills,
        testDirectory,
        verdicts,
        step1Reasoning,
        testCandidates,
        maxSteps,
    } = params;

    logger.info("Starting ResolutionAgent", {
        existingTests: existingTests.length,
        existingSkills: existingSkills.length,
        verdicts: verdicts.length,
        testCandidates: testCandidates.length,
    });

    const flowIndex = new FlowIndex([
        {
            id: "all",
            name: "All Tests",
            testSlugs: existingTests.map((t) => t.slug),
        },
    ]);

    const agent = new ResolutionAgent({
        model,
        workingDirectory: repoDir,
        flowIndex,
        testDirectory,
        maxSteps,
    });

    const result = await agent.resolve({ verdicts, step1Reasoning, testCandidates });

    logger.info("Resolution complete", {
        modifiedTests: result.modifiedTests.length,
        quarantinedTests: result.quarantinedTests.length,
        reportedBugs: result.reportedBugs.length,
        newTests: result.newTests.length,
    });

    return result;
}
