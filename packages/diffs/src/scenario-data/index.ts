// Promoted to @autonoma/scenario - re-exported here for backwards compatibility.
export {
    type ScenarioData,
    type ScenarioEntities,
    type ScenarioEntityRecord,
    scenarioDataSchema,
    scenarioEntitiesSchema,
    scenarioEntityRecordSchema,
    materializeScenarioData,
} from "@autonoma/scenario";
// Shared entity-graph primitives, reused by the scenario-recipe capability.
export { normalizeEntities } from "./normalize-entities";
export { summarizeEntities, type EntitySummaryHints } from "./summarize-entities";
