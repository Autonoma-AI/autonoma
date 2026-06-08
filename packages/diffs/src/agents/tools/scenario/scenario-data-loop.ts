import type { AgentLoop } from "@autonoma/ai";
import type { ScenarioData } from "../../../scenario-data";

/**
 * Loop that holds the materialized scenario-data payload in memory for the run
 * under review. Consumed by `read_scenario_entities`, which reads full per-type
 * records straight from {@link ScenarioDataLoop.scenarioData} with no DB or
 * network access - that's what keeps the run DB-free while still allowing
 * progressive disclosure for large scenarios.
 *
 * Optional: a run without a resolved scenario (no instance, failed UP, or empty
 * graph) carries no payload, and the tool is simply not offered.
 */
export interface ScenarioDataLoop extends AgentLoop {
    readonly scenarioData?: ScenarioData;
}
