import type { AgentLoop } from "@autonoma/ai";
import type { ScenarioIndex } from "../../../scenario-index";

/**
 * Loop that exposes named test data environments. Consumed by `list_scenarios` and `read_scenario`,
 * and indirectly by `add_test` when grounding a new test's preconditions.
 */
export interface ScenarioLookupLoop extends AgentLoop {
    readonly scenarioIndex: ScenarioIndex;
}
