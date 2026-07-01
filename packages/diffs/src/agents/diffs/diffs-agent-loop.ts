import { type AgentConfig, AgentLoop } from "@autonoma/ai";
import type { Codebase } from "../../codebase";
import type { ExistingTestInfo } from "../../diffs-agent";
import type { FlowIndex } from "../../flow-index";
import type { ScenarioIndex } from "../../scenario-index";
import type { ScenarioRecipeData } from "../../scenario-recipe";
import type { CodebaseLoop } from "../tools/codebase/codebase-loop";
import type { ScenarioLookupLoop } from "../tools/lookup/scenario-lookup-loop";
import type { TestLookupLoop } from "../tools/lookup/test-lookup-loop";
import type { ScenarioRecipeLoop } from "../tools/scenario/scenario-recipe-loop";
import type { AffectedTest } from "./affected-test";
import type { DiffsAgentResult } from "./diffs-agent";
import type { CreatedTest } from "./tools/create-test-tool";

interface DiffsAgentLoopParams extends AgentConfig<DiffsAgentResult> {
    codebase: Codebase;
    flowIndex: FlowIndex;
    existingTests: ExistingTestInfo[];
    /** The application's scenarios, for `list_scenarios` / `read_scenario` and `create_test` binding. */
    scenarioIndex: ScenarioIndex;
    /** Affected-test entries seeded before the loop runs (pre-classified merge conflicts). */
    seededAffected: AffectedTest[];
    validSlugs: ReadonlySet<string>;
    validConflictSlugs: ReadonlySet<string>;
    /** Materialized recipe templates for the scenarios the tests in scope reference. Empty when none apply. */
    scenarioRecipes: ScenarioRecipeData[];
}

/**
 * Per-run state for the {@link DiffsAgent}. Implements the {@link CodebaseLoop},
 * {@link TestLookupLoop}, and {@link ScenarioLookupLoop} capabilities so the
 * shared codebase + lookup tools can read the snapshot's clone, flow tree, test
 * list, and scenarios directly off the loop. Action tools mutate
 * {@link affectedTests} / {@link createdTests} directly; the validation sets
 * ({@link validSlugs}, {@link validConflictSlugs}) are exposed for tools to
 * guard against bad input.
 */
export class DiffsAgentLoop
    extends AgentLoop<DiffsAgentResult>
    implements CodebaseLoop, TestLookupLoop, ScenarioLookupLoop, ScenarioRecipeLoop
{
    public readonly codebase: Codebase;
    public readonly flowIndex: FlowIndex;
    public readonly existingTests: ExistingTestInfo[];
    public readonly scenarioIndex: ScenarioIndex;

    /** Mutable list of affected tests. Seeded with pre-classified merge conflicts, appended by `mark_affected_test`. */
    public readonly affectedTests: AffectedTest[];
    /** Mutable list of tests the agent authored, appended by `create_test`. The runner mints each one. */
    public readonly createdTests: CreatedTest[] = [];

    /** Valid slugs - tests that exist in this snapshot. */
    public readonly validSlugs: ReadonlySet<string>;
    /** Slugs of pre-classified merge conflicts the agent must enrich. */
    public readonly validConflictSlugs: ReadonlySet<string>;

    /** Recipe templates the `read_scenario_recipe_entities` tool discloses on demand. */
    public readonly scenarioRecipes: ScenarioRecipeData[];

    constructor({
        codebase,
        flowIndex,
        existingTests,
        scenarioIndex,
        seededAffected,
        validSlugs,
        validConflictSlugs,
        scenarioRecipes,
        ...config
    }: DiffsAgentLoopParams) {
        super(config);
        this.codebase = codebase;
        this.flowIndex = flowIndex;
        this.existingTests = existingTests;
        this.scenarioIndex = scenarioIndex;
        this.affectedTests = [...seededAffected];
        this.validSlugs = validSlugs;
        this.validConflictSlugs = validConflictSlugs;
        this.scenarioRecipes = scenarioRecipes;
    }

    protected override snapshotPartial(): { affectedTests: AffectedTest[]; createdTests: CreatedTest[] } {
        return { affectedTests: [...this.affectedTests], createdTests: [...this.createdTests] };
    }
}
