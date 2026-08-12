import type { ScenarioEntities, ScenarioEntityRecord } from "./types";

/**
 * Entity-type names that would corrupt the plain object we build up rather than
 * become an own property. `__proto__` is the dangerous one: `obj["__proto__"] =
 * value` hits the inherited setter and reparents the object (silently dropping
 * the type); `constructor`/`prototype` are rejected too as belt-and-suspenders.
 * These names arrive from untrusted JSON (`generatedData` / recipe `create`).
 */
const UNSAFE_ENTITY_TYPES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Normalize a raw entity graph - the `Record<modelName, records[]>` shape shared
 * by an instance's `generatedData` and a recipe's declared `create` block - into
 * the serializable {@link ScenarioEntities} map.
 */
export function normalizeEntities(raw: unknown): ScenarioEntities | undefined {
    if (!isPlainObject(raw)) return undefined;

    const entities: ScenarioEntities = {};
    for (const [entityType, value] of Object.entries(raw)) {
        if (UNSAFE_ENTITY_TYPES.has(entityType)) continue;
        if (!Array.isArray(value)) continue;
        const records = value.filter(isPlainObject);
        if (records.length === 0) continue;
        entities[entityType] = records;
    }

    return Object.keys(entities).length > 0 ? entities : undefined;
}

function isPlainObject(value: unknown): value is ScenarioEntityRecord {
    return typeof value === "object" && value != null && !Array.isArray(value);
}
