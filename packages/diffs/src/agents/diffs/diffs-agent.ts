import { Agent, type AgentTool, type LanguageModel } from "@autonoma/ai";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { ModelMessage } from "ai";
import type { Codebase } from "../../codebase";
import { buildDiffAnalysis } from "../../diff-analysis";
import type { ExistingTestInfo, MergeContextInfo, PreClassifiedConflictInfo } from "../../diffs-agent";
import type { FlowIndex } from "../../flow-index";
import { PLAN_AUTHORING_GUIDE } from "../../healing";
import type { ScenarioRecipeData } from "../../scenario-recipe";
import {
    buildCodebaseTools,
    ListFlowsTool,
    ListTestsTool,
    ReadScenarioRecipeEntitiesTool,
    ReadTestsTool,
    SubagentTool,
} from "../tools";
import type { AffectedTest } from "./affected-test";
import { DiffsAgentLoop } from "./diffs-agent-loop";
import { DIFFS_SYSTEM_PROMPT, buildDiffsUserPrompt } from "./diffs-prompt";
import { DiffsResultTool } from "./diffs-result-tool";
import { ExplainMergeConflictTool } from "./tools/explain-merge-conflict-tool";
import { MarkAffectedTestTool } from "./tools/mark-affected-test-tool";
import { SuggestTestTool, type TestCandidate } from "./tools/suggest-test-tool";

export interface DiffsAgentConfig {
    model: LanguageModel;
}

/**
 * Per-snapshot input for the DiffsAgent.
 *
 * The base SHA + head SHA bound the diff to analyse; `codebase` is the on-disk
 * clone the tools read from. Everything else is suite metadata so the agent
 * can ground its decisions without re-querying the DB.
 */
export interface DiffsAgentInput {
    headSha: string;
    baseSha: string;
    codebase: Codebase;
    flowIndex: FlowIndex;
    existingTests: ExistingTestInfo[];
    /** Merges in the range that were deterministically processed before the agent ran. Empty for non-merge runs. */
    merges?: MergeContextInfo[];
    /** Merge-conflict tests to enrich with reasoning. Empty for non-merge runs. */
    preClassifiedConflicts?: PreClassifiedConflictInfo[];
    /** Free-text testing guidelines from the application owner. */
    testScopeGuidelines?: string;
    /**
     * Recipe **templates** for the scenarios the tests in scope reference,
     * resolved at setup from each scenario's point-in-time
     * `ScenarioRecipeVersion.fixtureJson`. This is template data (what each
     * scenario is designed to seed), NOT per-run instance data - analysis runs
     * before any replay, so no instance exists yet. Omitted/empty when no test in
     * scope references a scenario with a usable recipe.
     */
    scenarioRecipes?: ScenarioRecipeData[];
}

export interface DiffsAgentResult {
    affectedTests: AffectedTest[];
    testCandidates: TestCandidate[];
    reasoning: string;
}

const SYSTEM_PROMPT = `${DIFFS_SYSTEM_PROMPT}\n\n${PLAN_AUTHORING_GUIDE}`;

/**
 * QA-engineer agent: analyses a code diff between two SHAs and produces an
 * affected-test list + new-test suggestions. Owns a fixed set of action,
 * lookup, and codebase tools assembled at construction time; per-run state
 * (codebase, flow tree, validation sets) flows through {@link DiffsAgentLoop}.
 */
export class DiffsAgent extends Agent<DiffsAgentInput, DiffsAgentResult, DiffsAgentLoop> {
    private readonly logger: Logger;
    private readonly model: LanguageModel;

    private readonly codebaseTools = buildCodebaseTools();
    private readonly subagentTool: SubagentTool;
    private readonly listFlowsTool = new ListFlowsTool();
    private readonly listTestsTool = new ListTestsTool();
    private readonly readTestsTool = new ReadTestsTool();
    private readonly markAffectedTestTool = new MarkAffectedTestTool();
    private readonly explainMergeConflictTool = new ExplainMergeConflictTool();
    private readonly suggestTestTool = new SuggestTestTool();
    private readonly readScenarioRecipeEntitiesTool = new ReadScenarioRecipeEntitiesTool();
    private readonly resultTool = new DiffsResultTool();

    constructor({ model }: DiffsAgentConfig) {
        super();
        this.model = model;
        this.logger = rootLogger.child({ name: this.constructor.name });
        this.subagentTool = new SubagentTool(model);
    }

    protected async buildUserPrompt(input: DiffsAgentInput): Promise<ModelMessage[]> {
        const analysis = await buildDiffAnalysis(input.codebase.root, input.headSha, input.baseSha, this.logger);
        const prompt = buildDiffsUserPrompt({
            analysis,
            flowIndex: input.flowIndex,
            merges: input.merges ?? [],
            preClassifiedConflicts: input.preClassifiedConflicts ?? [],
            testScopeGuidelines: input.testScopeGuidelines,
            scenarioRecipes: input.scenarioRecipes ?? [],
        });
        return [{ role: "user", content: prompt }];
    }

    protected async createLoop(input: DiffsAgentInput): Promise<DiffsAgentLoop> {
        const seededAffected: AffectedTest[] = (input.preClassifiedConflicts ?? []).map((c) => ({
            slug: c.slug,
            testName: c.testName,
            affectedReason: "merge_conflict" as const,
            reasoning: "",
        }));

        const scenarioRecipes = input.scenarioRecipes ?? [];

        // The recipe disclosure tool is only offered when at least one scenario
        // recipe was actually resolved - advertising a tool with no data to read
        // just wastes a turn. The recipe summary section in the prompt is gated
        // the same way.
        const tools: AgentTool<unknown, unknown>[] = [
            ...this.codebaseTools,
            this.subagentTool,
            this.listFlowsTool,
            this.listTestsTool,
            this.readTestsTool,
            this.markAffectedTestTool,
            this.explainMergeConflictTool,
            this.suggestTestTool,
        ];
        if (scenarioRecipes.length > 0) tools.push(this.readScenarioRecipeEntitiesTool);

        return new DiffsAgentLoop({
            name: "DiffsAgent",
            model: this.model,
            systemPrompt: SYSTEM_PROMPT,
            tools,
            reportTool: this.resultTool,
            codebase: input.codebase,
            flowIndex: input.flowIndex,
            existingTests: input.existingTests,
            seededAffected,
            validSlugs: new Set(input.existingTests.map((t) => t.slug)),
            quarantinedSlugs: new Set(input.existingTests.filter((t) => t.quarantine != null).map((t) => t.slug)),
            validConflictSlugs: new Set((input.preClassifiedConflicts ?? []).map((c) => c.slug)),
            scenarioRecipes,
        });
    }
}
