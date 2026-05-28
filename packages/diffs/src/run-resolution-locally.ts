import { randomUUID } from "node:crypto";
import type { LanguageModel } from "@autonoma/ai";
import { logger as rootLogger } from "@autonoma/logger";
import {
    ResolutionAgent,
    type ResolutionAgentResult,
    type RunReviewVerdict,
    type TestCandidateInput,
} from "./agents/resolution/resolution-agent";
import { Codebase } from "./codebase";
import type { ExistingTestInfo } from "./diffs-agent";
import { FlowIndex } from "./flow-index";
import { ScenarioIndex, type ScenarioInfo } from "./scenario-index";

export type LocalTestCandidateInput = Omit<TestCandidateInput, "candidateId"> & { candidateId?: string };

export interface LocalResolutionRunnerParams {
    model: LanguageModel;
    repoDir: string;
    existingTests: ExistingTestInfo[];
    verdicts: RunReviewVerdict[];
    step1Reasoning: string;
    testCandidates: LocalTestCandidateInput[];
    scenarios?: ScenarioInfo[];
    /**
     * Real per-flow index from {@link loadFlows}. When omitted the runner falls
     * back to a flat single-flow index containing every test, which is fine for
     * ad-hoc local runs but does not mirror production fidelity.
     */
    flowIndex?: FlowIndex;
}

/** Local-dev runner for {@link ResolutionAgent}. Symmetric to {@link runDiffsAgentLocally}. */
export async function runResolutionAgentLocally(params: LocalResolutionRunnerParams): Promise<ResolutionAgentResult> {
    const logger = rootLogger.child({ name: "runResolutionAgentLocally", repoDir: params.repoDir });
    const {
        model,
        repoDir,
        existingTests,
        verdicts,
        step1Reasoning,
        testCandidates,
        scenarios,
        flowIndex: providedFlowIndex,
    } = params;

    logger.info("Starting ResolutionAgent", {
        existingTests: existingTests.length,
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

    const codebase = new Codebase(repoDir);
    const scenarioIndex = new ScenarioIndex(scenarios ?? []);
    const agent = new ResolutionAgent({ model });

    const candidatesWithIds: TestCandidateInput[] = testCandidates.map((c) => ({
        candidateId: c.candidateId ?? randomUUID(),
        name: c.name,
        instruction: c.instruction,
        reasoning: c.reasoning,
    }));

    const { result } = await agent.run({
        codebase,
        flowIndex,
        scenarioIndex,
        existingTests,
        verdicts,
        step1Reasoning,
        testCandidates: candidatesWithIds,
    });

    logger.info("Resolution complete", {
        modifiedTests: result.modifiedTests.length,
        removedTests: result.removedTests.length,
        reportedBugs: result.reportedBugs.length,
        newTests: result.newTests.length,
    });

    return result;
}
