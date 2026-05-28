import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type LanguageModel } from "@autonoma/ai";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { ModelMessage } from "ai";
import type { Codebase } from "../../codebase";
import type { HealingAction } from "../../healing/actions";
import { PLAN_AUTHORING_GUIDE } from "../../healing/plan-authoring";
import { buildHealingPrompt } from "../../healing/prompt-builder";
import type { FailureRecord, PlanAuthoringInput, SnapshotInfo } from "../../healing/types";
import {
    BashTool,
    GlobTool,
    GrepTool,
    ListDirectoryTool,
    ListScenariosTool,
    ReadFilesTool,
    ReadScenarioTool,
    SubagentTool,
} from "../tools";
import { HealingAgentLoop } from "./healing-agent-loop";
import { HealingResultTool } from "./healing-result-tool";
import { HealingRemoveTestTool } from "./tools/remove-test-tool";
import { HealingReportBugTool } from "./tools/report-bug-tool";
import { ReportEngineLimitationTool } from "./tools/report-engine-limitation-tool";
import { UpdatePlanTool } from "./tools/update-plan-tool";

const SYSTEM_PROMPT_BASE = readFileSync(join(import.meta.dirname, "../../healing/system-prompt.md"), "utf-8");
const SYSTEM_PROMPT = `${SYSTEM_PROMPT_BASE}\n\n${PLAN_AUTHORING_GUIDE}`;

export interface HealingAgentConfig {
    model: LanguageModel;
}

/** Per-iteration input the {@link HealingAgent} receives. */
export interface HealingInput extends SnapshotInfo {
    /** 1-indexed iteration number within the refinement loop. */
    iteration: number;
    /** Actions emitted in earlier iterations of the same loop. */
    priorActions: HealingAction[];
    failures: FailureRecord[];
    /**
     * Subset of failures' testCaseIds that may be targeted by report_bug
     * or report_engine_limitation - i.e. those whose failure carries a
     * source review the apply layer can link evidence to.
     */
    reportableTestCaseIds: Set<string>;
    codebase: Codebase;
    planAuthoring: PlanAuthoringInput;
}

export interface HealingResult {
    actions: HealingAction[];
    reasoning: string;
}

/**
 * Diagnoses failing test plans inside a refinement loop iteration and decides
 * what to do about each one. Emits a structured action list; the runner is
 * responsible for applying the actions via Temporal activities.
 */
export class HealingAgent extends Agent<HealingInput, HealingResult, HealingAgentLoop> {
    private readonly logger: Logger;
    private readonly model: LanguageModel;

    private readonly bashTool = new BashTool();
    private readonly globTool = new GlobTool();
    private readonly grepTool = new GrepTool();
    private readonly listDirectoryTool = new ListDirectoryTool();
    private readonly readFilesTool = new ReadFilesTool();
    private readonly subagentTool: SubagentTool;
    private readonly listScenariosTool = new ListScenariosTool();
    private readonly readScenarioTool = new ReadScenarioTool();
    private readonly updatePlanTool = new UpdatePlanTool();
    private readonly reportBugTool = new HealingReportBugTool();
    private readonly reportEngineLimitationTool = new ReportEngineLimitationTool();
    private readonly removeTestTool = new HealingRemoveTestTool();
    private readonly resultTool = new HealingResultTool();

    constructor({ model }: HealingAgentConfig) {
        super();
        this.model = model;
        this.logger = rootLogger.child({ name: this.constructor.name });
        this.subagentTool = new SubagentTool(model);
    }

    protected async buildUserPrompt(input: HealingInput): Promise<ModelMessage[]> {
        this.logger.info("Building healing prompt", {
            iteration: input.iteration,
            failures: input.failures.length,
            snapshotId: input.snapshotId,
        });
        return [{ role: "user", content: buildHealingPrompt(input) }];
    }

    protected async createLoop(input: HealingInput): Promise<HealingAgentLoop> {
        return new HealingAgentLoop({
            name: "HealingAgent",
            model: this.model,
            systemPrompt: SYSTEM_PROMPT,
            tools: [
                this.bashTool,
                this.globTool,
                this.grepTool,
                this.listDirectoryTool,
                this.readFilesTool,
                this.subagentTool,
                this.listScenariosTool,
                this.readScenarioTool,
                this.updatePlanTool,
                this.reportBugTool,
                this.reportEngineLimitationTool,
                this.removeTestTool,
            ],
            reportTool: this.resultTool,
            codebase: input.codebase,
            scenarioIndex: input.planAuthoring.scenarios,
            failureKeysByTestCaseId: new Map(input.failures.map((f) => [f.testCaseId, f.key])),
            failureKeys: new Set(input.failures.map((f) => f.key)),
            reportableTestCaseIds: input.reportableTestCaseIds,
        });
    }
}
