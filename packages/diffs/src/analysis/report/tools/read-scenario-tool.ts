import { AgentTool } from "@autonoma/ai";
import { z } from "zod";
import type { ReporterAgentLoop } from "../reporter-agent-loop";
import type { ReporterScenarioRecipe } from "../types";

const inputSchema = z.object({
    scenarioId: z.string().describe("The id of the scenario to read (from the scenario index in the prompt)."),
});

type ReadScenarioInput = z.infer<typeof inputSchema>;

type ReadScenarioOutput = ReporterScenarioRecipe;

const DESCRIPTION =
    "Read the full recipe for one scenario by id - exactly what data + auth it seeds. Use it when deciding whether a failure is a scenario/data gap (the recipe does not create the records the test needs) rather than an app bug. Fetch a recipe only when a finding turns on setup; do not read every scenario.";

/**
 * On-demand scenario recipe fetch for the Reporter. Delegates to {@link ReporterAgentLoop.readScenario}, which
 * validates the id against the run's scenario index and loads the full recipe via the injected loader (throwing a
 * fixable error for an unknown id or one with no readable recipe). Only added to the agent when a loader and a
 * non-empty index are present, so it is never advertised with nothing to read.
 */
export class ReadScenarioTool extends AgentTool<ReadScenarioInput, ReadScenarioOutput, ReporterAgentLoop> {
    constructor() {
        super({ name: "read_scenario", description: DESCRIPTION, inputSchema });
    }

    protected async execute({ scenarioId }: ReadScenarioInput, loop: ReporterAgentLoop): Promise<ReadScenarioOutput> {
        return loop.readScenario(scenarioId);
    }
}
