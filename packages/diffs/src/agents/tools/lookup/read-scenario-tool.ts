import { AgentTool, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import type { ScenarioInfo } from "../../../scenario-index";
import type { ScenarioLookupLoop } from "./scenario-lookup-loop";

const readScenarioInputSchema = z.object({
    scenarioId: z.string().describe("The id of the scenario to read (obtained from `list_scenarios`)."),
});

type ReadScenarioInput = z.infer<typeof readScenarioInputSchema>;

type ReadScenarioOutput = Pick<ScenarioInfo, "id" | "name" | "description" | "activeRecipe" | "sampleMetadata">;

class UnknownScenarioError extends FixableToolError {
    constructor(public readonly scenarioId: string) {
        super(`Scenario "${scenarioId}" not found.`);
    }

    override suggestFix(): string {
        return "Call `list_scenarios` to see the available scenario ids, then try again with one of those.";
    }
}

/** Read full detail (recipe + sample metadata) for a single scenario. */
export class ReadScenarioTool extends AgentTool<ReadScenarioInput, ReadScenarioOutput, ScenarioLookupLoop> {
    constructor() {
        super({
            name: "read_scenario",
            description:
                "Read the full details of a specific scenario by id. Returns the scenario's name, description, " +
                "the recipe that defines exactly what data gets seeded (models + fields), and sample metadata from " +
                "a past instance (e.g., the test user's email or role) when available. Use this to verify that a " +
                "scenario seeds the preconditions a new test needs before picking it in `add_test`.",
            inputSchema: readScenarioInputSchema,
        });
    }

    protected async execute({ scenarioId }: ReadScenarioInput, loop: ScenarioLookupLoop): Promise<ReadScenarioOutput> {
        const scenario = loop.scenarioIndex.getScenario(scenarioId);
        if (scenario == null) throw new UnknownScenarioError(scenarioId);
        return {
            id: scenario.id,
            name: scenario.name,
            description: scenario.description,
            activeRecipe: scenario.activeRecipe,
            sampleMetadata: scenario.sampleMetadata,
        };
    }
}
