import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { ScenarioIndex } from "../../../scenario-index";
import type { ScenarioLookupLoop } from "./scenario-lookup-loop";

interface ListScenariosOutput {
    scenarios: ReturnType<ScenarioIndex["listScenarios"]>;
}

/** List all scenarios (named test data environments) for the application. */
export class ListScenariosTool extends AgentTool<Record<string, never>, ListScenariosOutput, ScenarioLookupLoop> {
    constructor() {
        super({
            name: "list_scenarios",
            description:
                "List all scenarios (named test data environments) available for this application. " +
                "Each scenario seeds the app with a specific state (e.g., an authenticated user with pre-existing records) " +
                "before a test runs and cleans it up after. Returns id, name, and description. " +
                "Use `read_scenario` to inspect a specific scenario's seeded data in detail.",
            inputSchema: z.object({}),
        });
    }

    protected async execute(_input: Record<string, never>, loop: ScenarioLookupLoop): Promise<ListScenariosOutput> {
        return { scenarios: loop.scenarioIndex.listScenarios() };
    }
}
