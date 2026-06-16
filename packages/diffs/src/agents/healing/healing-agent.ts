import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type LanguageModel, RedactOldToolResults } from "@autonoma/ai";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { ModelMessage } from "ai";
import type { Codebase } from "../../codebase";
import type { ExistingTestInfo } from "../../diffs-agent";
import type { FlowIndex } from "../../flow-index";
import type { HealingAction, HealingReviewLink } from "../../healing/actions";
import { PLAN_AUTHORING_GUIDE } from "../../healing/plan-authoring";
import { buildHealingPrompt } from "../../healing/prompt-builder";
import type {
    FailureRecord,
    HealingRejectedCandidate,
    HealingTestCandidate,
    PlanAuthoringInput,
    SnapshotInfo,
} from "../../healing/types";
import type { SnapshotChangeContext } from "../../review/snapshot";
import {
    buildCodebaseTools,
    ListFlowsTool,
    ListScenariosTool,
    ListTestsTool,
    ReadScenarioTool,
    ReadTestsTool,
    SubagentTool,
} from "../tools";
import { HealingAgentLoop } from "./healing-agent-loop";
import { HealingResultTool } from "./healing-result-tool";
import { HealingAddTestTool, type HealingNewTest } from "./tools/add-test-tool";
import { HealingRemoveTestTool } from "./tools/remove-test-tool";
import { HealingReportBugTool } from "./tools/report-bug-tool";
import { ReportEngineLimitationTool } from "./tools/report-engine-limitation-tool";
import { UpdatePlanTool } from "./tools/update-plan-tool";

const SYSTEM_PROMPT_BASE = readFileSync(join(import.meta.dirname, "../../healing/system-prompt.md"), "utf-8");
const SYSTEM_PROMPT = `${SYSTEM_PROMPT_BASE}\n\n${PLAN_AUTHORING_GUIDE}`;

/**
 * Token budget for the previous step's input before compaction trims. Sized to leave headroom
 * for the next step's request - a typical tool round-trip adds ~100-200k tokens on top - so we
 * stay well under Gemini's 1M ceiling.
 */
const COMPACTION_TOKEN_THRESHOLD = 700_000;
/** Number of most recent tool round-trips to keep in full when compaction fires. */
const COMPACTION_KEEP_RECENT_TOOL_RESULTS = 2;

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
     * The diff anchor (base/head SHAs) shared by every failure - the codebase is
     * checked out at head with base also fetched, so the agent can
     * `git diff baseSha..headSha`. Absent for a SHA-less snapshot; the prompt
     * builder asserts its presence.
     */
    change?: SnapshotChangeContext;
    /**
     * `DiffsJob.analysisReasoning` - the diffs-agent's natural-language summary of
     * what changed across the snapshot. Carried independently of {@link change}
     * so it survives a SHA-less snapshot. Required: healing runs strictly
     * downstream of a successful analysis, so it is always set (empty string only
     * in the unreachable analysis-recorded-nothing case).
     */
    analysisReasoning: string;
    /**
     * New-test candidates offered for this turn (today, only the first turn,
     * seeded from the diff-analysis step). Empty on turns with no candidates,
     * in which case `add_test` falls back to first-turn spontaneous proposals
     * and the result tool's candidate clause is vacuously satisfied.
     */
    candidates: HealingTestCandidate[];
    codebase: Codebase;
    /** The suite's flow (folder) tree, for `list_flows` / `list_tests` and `add_test` folder validation. */
    flowIndex: FlowIndex;
    /** The existing tests in the suite, for `list_tests` / `read_tests`. */
    existingTests: ExistingTestInfo[];
    planAuthoring: PlanAuthoringInput;
}

export interface HealingResult {
    actions: HealingAction[];
    /** New tests the agent decided to add this turn (accepted candidates + first-turn spontaneous adds). */
    newTests: HealingNewTest[];
    /** Candidates the agent explicitly rejected this turn. */
    rejectedCandidates: HealingRejectedCandidate[];
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

    private readonly codebaseTools = buildCodebaseTools();
    private readonly subagentTool: SubagentTool;
    private readonly listFlowsTool = new ListFlowsTool();
    private readonly listTestsTool = new ListTestsTool();
    private readonly readTestsTool = new ReadTestsTool();
    private readonly listScenariosTool = new ListScenariosTool();
    private readonly readScenarioTool = new ReadScenarioTool();
    private readonly updatePlanTool = new UpdatePlanTool();
    private readonly reportBugTool = new HealingReportBugTool();
    private readonly reportEngineLimitationTool = new ReportEngineLimitationTool();
    private readonly removeTestTool = new HealingRemoveTestTool();
    private readonly addTestTool = new HealingAddTestTool();
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
        const reviewLinksByTestCaseId = new Map<string, HealingReviewLink>();
        for (const f of input.failures) {
            if (f.reviewLink != null) reviewLinksByTestCaseId.set(f.testCaseId, f.reviewLink);
        }

        return new HealingAgentLoop({
            name: "HealingAgent",
            model: this.model,
            systemPrompt: SYSTEM_PROMPT,
            tools: [
                ...this.codebaseTools,
                this.subagentTool,
                this.listFlowsTool,
                this.listTestsTool,
                this.readTestsTool,
                this.listScenariosTool,
                this.readScenarioTool,
                this.updatePlanTool,
                this.reportBugTool,
                this.reportEngineLimitationTool,
                this.removeTestTool,
                this.addTestTool,
            ],
            reportTool: this.resultTool,
            compactor: {
                strategy: new RedactOldToolResults(COMPACTION_KEEP_RECENT_TOOL_RESULTS),
                threshold: COMPACTION_TOKEN_THRESHOLD,
            },
            codebase: input.codebase,
            flowIndex: input.flowIndex,
            existingTests: input.existingTests,
            scenarioIndex: input.planAuthoring.scenarios,
            failureKeysByTestCaseId: new Map(input.failures.map((f) => [f.testCaseId, f.key])),
            failureKeys: new Set(input.failures.map((f) => f.key)),
            reviewLinksByTestCaseId,
            candidatesById: new Map(input.candidates.map((c) => [c.candidateId, c])),
            isFirstTurn: input.iteration === 1,
        });
    }
}
