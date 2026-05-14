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
import { ScenarioIndex, type ScenarioInfo } from "./scenario-index";

export interface LocalResolutionRunnerParams {
    model: LanguageModel;
    repoDir: string;
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
    verdicts: RunReviewVerdict[];
    step1Reasoning: string;
    testCandidates: TestCandidateInput[];
    scenarios?: ScenarioInfo[];
    maxSteps?: number;
}

export async function runResolutionAgentLocally(params: LocalResolutionRunnerParams): Promise<ResolutionAgentResult> {
    const logger = rootLogger.child({ name: "runResolutionAgentLocally", repoDir: params.repoDir });
    const {
        model,
        repoDir,
        existingTests,
        existingSkills,
        verdicts,
        step1Reasoning,
        testCandidates,
        scenarios,
        maxSteps,
    } = params;

    logger.info("Starting ResolutionAgent", {
        existingTests: existingTests.length,
        existingSkills: existingSkills.length,
        verdicts: verdicts.length,
        testCandidates: testCandidates.length,
        scenarios: scenarios?.length ?? 0,
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
        scenarioIndex: new ScenarioIndex(scenarios ?? []),
        maxSteps,
    });

    const result = await agent.resolve({ verdicts, step1Reasoning, testCandidates, existingTests, existingSkills });

    logger.info("Resolution complete", {
        modifiedTests: result.modifiedTests.length,
        quarantinedTests: result.quarantinedTests.length,
        reportedBugs: result.reportedBugs.length,
        newTests: result.newTests.length,
    });

    return result;
}
