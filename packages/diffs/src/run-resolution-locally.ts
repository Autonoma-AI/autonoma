import { randomUUID } from "node:crypto";
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

export type LocalTestCandidateInput = Omit<TestCandidateInput, "candidateId"> & { candidateId?: string };

export interface LocalResolutionRunnerParams {
    model: LanguageModel;
    repoDir: string;
    existingTests: ExistingTestInfo[];
    existingSkills: ExistingSkillInfo[];
    verdicts: RunReviewVerdict[];
    step1Reasoning: string;
    testCandidates: LocalTestCandidateInput[];
    scenarios?: ScenarioInfo[];
    /**
     * Real per-flow index from {@link loadFlows}. When omitted the runner
     * falls back to a flat single-flow index containing every test, which is
     * fine for ad-hoc local runs but does not mirror production fidelity.
     */
    flowIndex?: FlowIndex;
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
        flowIndex: providedFlowIndex,
        maxSteps,
    } = params;

    logger.info("Starting ResolutionAgent", {
        existingTests: existingTests.length,
        existingSkills: existingSkills.length,
        verdicts: verdicts.length,
        testCandidates: testCandidates.length,
        scenarios: scenarios?.length ?? 0,
        flowIndexProvided: providedFlowIndex != null,
    });

    const flowIndex =
        providedFlowIndex ??
        new FlowIndex([
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

    const candidatesWithIds: TestCandidateInput[] = testCandidates.map((c) => ({
        candidateId: c.candidateId ?? randomUUID(),
        name: c.name,
        instruction: c.instruction,
        reasoning: c.reasoning,
    }));

    const result = await agent.resolve({
        verdicts,
        step1Reasoning,
        testCandidates: candidatesWithIds,
        existingTests,
        existingSkills,
    });

    logger.info("Resolution complete", {
        modifiedTests: result.modifiedTests.length,
        removedTests: result.removedTests.length,
        reportedBugs: result.reportedBugs.length,
        newTests: result.newTests.length,
    });

    return result;
}
