import { summarizeEntities } from "./summarize-entities";
import type { ScenarioData } from "./types";

/**
 * Render a bounded, human-legible summary of the scenario data for the reviewer
 * prompt. For each entity type it inlines the count, each record's `_alias`, and
 * 1-2 identifying field values - enough for the agent to judge whether the test
 * plan references data the scenario actually created (the core "malformed test
 * depends on data the scenario never generated" signal) without dumping every
 * full record. Pure: no DB, no I/O.
 *
 * This describes the data a run's scenario instance *actually generated* (its
 * resolved per-run graph). The recipe summary is its template-level sibling -
 * see {@link summarizeScenarioRecipes} in `../scenario-recipe`.
 */
export function summarizeScenarioData(data: ScenarioData): string {
    const body = summarizeEntities(data.entities, {
        moreRecords: (entityType, remaining) =>
            `- ...and ${remaining} more. Call \`read_scenario_entities("${entityType}")\` for the full list.`,
        moreTypes: (remaining) =>
            `### ...and ${remaining.length} more entity types: ${remaining.join(", ")}. Use \`read_scenario_entities\` to read any of them.`,
    });

    return [
        `This run executed against scenario **${data.scenarioName}**, which seeded the data below.`,
        "Use the `read_scenario_entities` tool to read the full records for any type. A test plan that depends on data not listed here (a user, item, or value the scenario never created) is malformed - that points to a stale/incorrect test rather than an application bug.",
        "",
        body,
    ].join("\n");
}
