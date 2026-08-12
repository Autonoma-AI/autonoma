import { z } from "zod";

/**
 * One materialized entity record from a scenario's resolved "create" graph.
 *
 * Carries an optional `_alias` (the handle other entities reference) plus
 * arbitrary field values - scalars, `{ _ref: "<alias>" }` relationship
 * references, or semantic event-tokens.
 */
export const scenarioEntityRecordSchema = z.record(z.string(), z.unknown());
export type ScenarioEntityRecord = z.infer<typeof scenarioEntityRecordSchema>;

export const scenarioEntitiesSchema = z.record(z.string(), z.array(scenarioEntityRecordSchema));
export type ScenarioEntities = z.infer<typeof scenarioEntitiesSchema>;

/**
 * The data a run's scenario actually created, materialized from the
 * `ScenarioInstance.generatedData` graph persisted at UP success.
 */
export const scenarioDataSchema = z.object({
    scenarioName: z.string(),
    entities: scenarioEntitiesSchema,
});
export type ScenarioData = z.infer<typeof scenarioDataSchema>;
