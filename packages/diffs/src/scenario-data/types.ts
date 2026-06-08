import { z } from "zod";

/**
 * One materialized entity record from a scenario's resolved "create" graph.
 *
 * Carries an optional `_alias` (the handle other entities reference) plus
 * arbitrary field values - scalars, `{ _ref: "<alias>" }` relationship
 * references, or semantic event-tokens. The shape is deliberately open
 * (`z.unknown()` values): the create graph is application-defined and the
 * reviewer/healing agents read it opaquely.
 */
export const scenarioEntityRecordSchema = z.record(z.string(), z.unknown());
export type ScenarioEntityRecord = z.infer<typeof scenarioEntityRecordSchema>;

/** Entity-type -> records: the resolved create graph, keyed by model name. */
export const scenarioEntitiesSchema = z.record(z.string(), z.array(scenarioEntityRecordSchema));
export type ScenarioEntities = z.infer<typeof scenarioEntitiesSchema>;

/**
 * Subject-scoped, serializable snapshot of the data a run's scenario actually
 * created. Materialized by {@link materializeScenarioData} from the
 * `ScenarioInstance.generatedData` graph persisted at UP success (#815).
 *
 * Agent-agnostic by design: the replay reviewer consumes it today; resolution
 * and healing reuse the same payload, summary, and disclosure tool without
 * reimplementation.
 */
export const scenarioDataSchema = z.object({
    /** Human-friendly scenario name, surfaced in the summary so the agent can reason about it. */
    scenarioName: z.string(),
    entities: scenarioEntitiesSchema,
});
export type ScenarioData = z.infer<typeof scenarioDataSchema>;
