import { Agent, type LanguageModel } from "@autonoma/ai";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { ModelMessage } from "ai";
import type { Codebase } from "../../codebase";
import type { ExistingTestInfo } from "../../diffs-agent";
import type { FlowIndex } from "../../flow-index";
import { PLAN_AUTHORING_GUIDE } from "../../healing/plan-authoring";
import type { ScenarioIndex } from "../../scenario-index";
import type { AffectedReason } from "../diffs/affected-test";
import {
    BashTool,
    GlobTool,
    GrepTool,
    ListFlowsTool,
    ListScenariosTool,
    ListTestsTool,
    ReadFilesTool,
    ReadScenarioTool,
    ReadTestsTool,
    SubagentTool,
} from "../tools";
import { ResolutionAgentLoop } from "./resolution-agent-loop";
import { RESOLUTION_SYSTEM_PROMPT, buildResolutionUserPrompt } from "./resolution-prompt";
import { ResolutionResultTool } from "./resolution-result-tool";
import { AddTestTool, type GeneratedTest } from "./tools/add-test-tool";
import { ModifyTestTool, type ModifiedTest } from "./tools/modify-test-tool";
import { RemoveTestTool, type RemovedTest } from "./tools/remove-test-tool";
import { ReportBugTool, type ReportedBug } from "./tools/report-bug-tool";

export interface ResolutionAgentConfig {
    model: LanguageModel;
}

/** Reviewer's verdict on a single test replay, plus context the agent needs to act on it. */
export interface RunReviewVerdict {
    runId: string;
    testSlug: string;
    testName: string;
    originalPrompt: string;
    runStatus: string;
    verdict: string;
    reviewReasoning: string;
    issueTitle?: string;
    issueConfidence?: number;
    issueDescription?: string;
    affectedReason?: AffectedReason;
}

/** A new-test candidate carried forward from the Diffs step. */
export interface TestCandidateInput {
    candidateId: string;
    name: string;
    instruction: string;
    reasoning: string;
}

export interface ResolutionAgentInput {
    codebase: Codebase;
    flowIndex: FlowIndex;
    scenarioIndex: ScenarioIndex;
    existingTests: ExistingTestInfo[];
    verdicts: RunReviewVerdict[];
    step1Reasoning: string;
    testCandidates: TestCandidateInput[];
    /** Free-text testing guidelines from the application owner. */
    testScopeGuidelines?: string;
}

export interface ResolutionAgentResult {
    modifiedTests: ModifiedTest[];
    removedTests: RemovedTest[];
    reportedBugs: ReportedBug[];
    newTests: GeneratedTest[];
    reasoning: string;
}

const SYSTEM_PROMPT = `${RESOLUTION_SYSTEM_PROMPT}\n\n${PLAN_AUTHORING_GUIDE}`;

/**
 * Resolution agent: handles every failed-test verdict from a replay batch by
 * picking one of `modify_test`, `remove_test`, `report_bug`, and additionally
 * decides which Step 1 test candidates should graduate into real tests via
 * `add_test`. Tools are constructed once; the per-run loop holds the codebase,
 * the indices, and the failed/quarantined slug sets.
 */
export class ResolutionAgent extends Agent<ResolutionAgentInput, ResolutionAgentResult, ResolutionAgentLoop> {
    private readonly logger: Logger;
    private readonly model: LanguageModel;

    private readonly bashTool = new BashTool();
    private readonly globTool = new GlobTool();
    private readonly grepTool = new GrepTool();
    private readonly readFilesTool = new ReadFilesTool();
    private readonly subagentTool: SubagentTool;
    private readonly listFlowsTool = new ListFlowsTool();
    private readonly listTestsTool = new ListTestsTool();
    private readonly readTestsTool = new ReadTestsTool();
    private readonly listScenariosTool = new ListScenariosTool();
    private readonly readScenarioTool = new ReadScenarioTool();
    private readonly modifyTestTool = new ModifyTestTool();
    private readonly removeTestTool = new RemoveTestTool();
    private readonly reportBugTool = new ReportBugTool();
    private readonly addTestTool = new AddTestTool();
    private readonly resultTool = new ResolutionResultTool();

    constructor({ model }: ResolutionAgentConfig) {
        super();
        this.model = model;
        this.logger = rootLogger.child({ name: this.constructor.name });
        this.subagentTool = new SubagentTool(model);
    }

    protected async buildUserPrompt(input: ResolutionAgentInput): Promise<ModelMessage[]> {
        this.logger.info("Building resolution prompt", {
            verdicts: input.verdicts.length,
            candidates: input.testCandidates.length,
        });
        const prompt = buildResolutionUserPrompt(input, input.flowIndex, input.scenarioIndex);
        return [{ role: "user", content: prompt }];
    }

    protected async createLoop(input: ResolutionAgentInput): Promise<ResolutionAgentLoop> {
        return new ResolutionAgentLoop({
            name: "ResolutionAgent",
            model: this.model,
            systemPrompt: SYSTEM_PROMPT,
            tools: [
                this.bashTool,
                this.globTool,
                this.grepTool,
                this.readFilesTool,
                this.subagentTool,
                this.listFlowsTool,
                this.listTestsTool,
                this.readTestsTool,
                this.listScenariosTool,
                this.readScenarioTool,
                this.modifyTestTool,
                this.removeTestTool,
                this.reportBugTool,
                this.addTestTool,
            ],
            reportTool: this.resultTool,
            codebase: input.codebase,
            flowIndex: input.flowIndex,
            scenarioIndex: input.scenarioIndex,
            existingTests: input.existingTests,
            failedSlugs: new Set(input.verdicts.map((v) => v.testSlug)),
            quarantinedSlugs: new Set(input.existingTests.filter((t) => t.quarantine != null).map((t) => t.slug)),
        });
    }
}
