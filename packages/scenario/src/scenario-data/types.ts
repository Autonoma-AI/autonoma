import { z } from "zod";

export const scenarioEntityRecordSchema = z.record(z.string(), z.unknown());
export type ScenarioEntityRecord = z.infer<typeof scenarioEntityRecordSchema>;

export const scenarioEntitiesSchema = z.record(z.string(), z.array(scenarioEntityRecordSchema));
export type ScenarioEntities = z.infer<typeof scenarioEntitiesSchema>;

export const scenarioDataSchema = z.object({
    scenarioName: z.string(),
    entities: scenarioEntitiesSchema,
});
export type ScenarioData = z.infer<typeof scenarioDataSchema>;
