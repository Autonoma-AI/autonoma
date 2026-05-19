import { tool } from "ai";
import { z } from "zod";
import type { ScenarioLookup } from "../plan-authoring/types";

const readScenarioSchema = z.object({
    scenarioId: z.string().describe("The id of the scenario to read (obtained from `list_scenarios`)."),
});

export function buildScenarioTools(scenarioIndex: ScenarioLookup) {
    return {
        list_scenarios: tool({
            description:
                "List all scenarios (named test data environments) available for this application. " +
                "Each scenario seeds the app with a specific state (e.g., an authenticated user with pre-existing records) " +
                "before a test runs and cleans it up after. Returns id, name, and description. " +
                "Use `read_scenario` to inspect a specific scenario's seeded data in detail.",
            inputSchema: z.object({}),
            execute: async () => {
                const scenarios = scenarioIndex.listScenarios();
                return { scenarios };
            },
        }),
        read_scenario: tool({
            description:
                "Read the full details of a specific scenario by id. Returns the scenario's name, description, " +
                "the recipe that defines exactly what data gets seeded (models + fields), and sample metadata from " +
                "a past instance (e.g., the test user's email or role) when available. Use this to verify that a " +
                "scenario seeds the preconditions a plan needs before referencing it.",
            inputSchema: readScenarioSchema,
            execute: async ({ scenarioId }) => {
                const scenario = scenarioIndex.getScenario(scenarioId);
                if (scenario == null) {
                    return { error: `Scenario "${scenarioId}" not found.` };
                }
                return {
                    id: scenario.id,
                    name: scenario.name,
                    description: scenario.description,
                    activeRecipe: scenario.activeRecipe,
                    sampleMetadata: scenario.sampleMetadata,
                };
            },
        }),
    };
}
