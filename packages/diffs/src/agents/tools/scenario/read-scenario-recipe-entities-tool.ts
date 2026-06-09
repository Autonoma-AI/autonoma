import { AgentTool, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import type { ScenarioEntityRecord } from "../../../scenario-data";
import type { ScenarioRecipeData } from "../../../scenario-recipe";
import { boundRecords } from "./bound-records";
import type { ScenarioRecipeLoop } from "./scenario-recipe-loop";

/**
 * Aggregate output budget for a single call, mirroring the sibling
 * `read_scenario_entities` tool. Realistic recipes return every
 * record well under this; only a pathological type (thousands of declared rows,
 * or rows with large blob fields) is truncated, with a marker telling the model
 * how many records were dropped.
 */
const MAX_OUTPUT_CHARS = 60_000;

const readScenarioRecipeEntitiesInputSchema = z.object({
    scenario: z.string().describe("The scenario name to read from, exactly as listed in the scenario recipe summary."),
    entityType: z
        .string()
        .describe(
            "The entity type to read full declared records for, e.g. 'User'. Must be one of the types listed for that scenario in the recipe summary.",
        ),
});

type ReadScenarioRecipeEntitiesInput = z.infer<typeof readScenarioRecipeEntitiesInputSchema>;

interface ReadScenarioRecipeEntitiesOutput {
    scenario: string;
    entityType: string;
    /** Total records the recipe declares for this type, before any truncation. */
    count: number;
    records: ScenarioEntityRecord[];
    /** Present and true only when {@link MAX_OUTPUT_CHARS} forced some records to be dropped. */
    truncated?: boolean;
    /** Human-readable note describing the truncation, when it occurred. */
    note?: string;
}

class NoScenarioRecipesError extends FixableToolError {
    constructor() {
        super("The tests in scope reference no scenarios with a usable recipe, so there are no entities to read.");
    }

    override suggestFix(): string {
        return "Do not call read_scenario_recipe_entities for this analysis - reason about the diff from the code, flows, and test plans instead.";
    }
}

class UnknownScenarioError extends FixableToolError {
    constructor(
        public readonly scenario: string,
        public readonly availableScenarios: string[],
    ) {
        super(`Unknown scenario "${scenario}".`);
    }

    override suggestFix(): string {
        return `Available scenarios: ${this.availableScenarios.join(", ")}. Try again with one of those names exactly as listed in the recipe summary.`;
    }
}

class UnknownRecipeEntityTypeError extends FixableToolError {
    constructor(
        public readonly scenario: string,
        public readonly entityType: string,
        public readonly availableTypes: string[],
    ) {
        super(`Scenario "${scenario}" declares no entity type "${entityType}".`);
    }

    override suggestFix(): string {
        if (this.availableTypes.length === 0) {
            return `Scenario "${this.scenario}" declares no entity types - there is nothing to read.`;
        }
        return `Entity types for "${this.scenario}": ${this.availableTypes.join(", ")}. Try again with one of those.`;
    }
}

/**
 * In-memory progressive-disclosure tool: returns every record a scenario's
 * recipe *declares* for one entity type, read directly from the materialized
 * payloads held in {@link ScenarioRecipeLoop.scenarioRecipes}. No DB and no
 * network access - the recipe summary in the prompt is bounded, and an agent that
 * needs the full declared records for a type pulls them through here.
 *
 * This surfaces recipe template data (what a scenario is designed to seed), the
 * analysis-time counterpart of `read_scenario_entities` (per-run instance data).
 * Agent-agnostic: the diffs analysis agent offers it today.
 */
export class ReadScenarioRecipeEntitiesTool extends AgentTool<
    ReadScenarioRecipeEntitiesInput,
    ReadScenarioRecipeEntitiesOutput,
    ScenarioRecipeLoop
> {
    constructor() {
        super({
            name: "read_scenario_recipe_entities",
            description:
                "Read the full records a scenario's recipe declares for a single entity type. " +
                "The scenario recipe summary in the prompt lists each scenario's types with a bounded preview; call this " +
                "to see every field of every declared record for one type (e.g. to confirm whether a specific user, " +
                "item, or value a test plan references is something the scenario is designed to seed). This is recipe " +
                "template data, not per-run data. Reads from in-memory recipe data only - it performs no database or network access.",
            inputSchema: readScenarioRecipeEntitiesInputSchema,
        });
    }

    protected async execute(
        { scenario, entityType }: ReadScenarioRecipeEntitiesInput,
        loop: ScenarioRecipeLoop,
    ): Promise<ReadScenarioRecipeEntitiesOutput> {
        const recipes = loop.scenarioRecipes;
        if (recipes == null || recipes.length === 0) throw new NoScenarioRecipesError();

        const recipe = findRecipe(recipes, scenario);
        if (recipe == null) {
            throw new UnknownScenarioError(
                scenario,
                recipes.map((candidate) => candidate.scenarioName),
            );
        }

        const records = recipe.entities[entityType];
        if (records == null) {
            throw new UnknownRecipeEntityTypeError(scenario, entityType, Object.keys(recipe.entities));
        }

        const bounded = boundRecords(records, MAX_OUTPUT_CHARS);
        if (!bounded.truncated) {
            return { scenario: recipe.scenarioName, entityType, count: bounded.count, records: bounded.records };
        }

        return {
            scenario: recipe.scenarioName,
            entityType,
            count: bounded.count,
            records: bounded.records,
            truncated: true,
            note: `Returned the first ${bounded.records.length} of ${bounded.count} ${entityType} records the recipe declares; the rest were omitted because the full set exceeds the ${MAX_OUTPUT_CHARS}-char output budget.`,
        };
    }
}

/** Match a recipe by scenario name; scenario names are unique within an application. */
function findRecipe(recipes: ScenarioRecipeData[], scenario: string): ScenarioRecipeData | undefined {
    return recipes.find((recipe) => recipe.scenarioName === scenario);
}
