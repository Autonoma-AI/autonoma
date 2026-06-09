import type { ScenarioEntities, ScenarioEntityRecord } from "./types";

/**
 * Per-type record cap in the inlined summary. The full records for any type are
 * available on demand through the disclosure tool, so the prompt stays bounded
 * even for graphs that declare hundreds of rows.
 */
const MAX_RECORDS_PER_TYPE = 20;
/**
 * Cap on how many entity types are rendered, so the summary stays bounded even
 * for a graph with a huge number of types. Remaining types are named in a
 * trailing note; the agent can still read any of them via the disclosure tool.
 */
const MAX_ENTITY_TYPES = 30;
/** How many identifying fields to show per record (the issue's "1-2 identifying fields"). */
const MAX_IDENTIFYING_FIELDS = 2;
/** Truncate long field values so a single record can't blow the prompt budget. */
const MAX_VALUE_CHARS = 80;

/**
 * Field names that identify an entity to a human reader, in priority order.
 * When a record carries one of these, it's far more useful in the summary than
 * an arbitrary first field.
 */
const IDENTIFYING_FIELD_PRIORITY = ["name", "title", "email", "username", "handle", "slug", "label", "key", "id"];

/**
 * Disclosure-tool hints injected into the rendered summary. Each consumer (the
 * scenario-data summary, the scenario-recipe summary) names a different tool and
 * scopes its overflow notes differently (single scenario vs per-scenario), so
 * the entity-graph renderer stays agnostic and the caller supplies the prose.
 */
export interface EntitySummaryHints {
    /** Rendered line when a single type has more records than the inlined cap. */
    moreRecords: (entityType: string, remaining: number) => string;
    /** Rendered section when there are more entity types than the type cap. */
    moreTypes: (remainingTypes: string[]) => string;
}

/**
 * Render the bounded, human-legible body of an entity graph: for each entity
 * type, the count, each record's `_alias`, and 1-2 identifying field values -
 * enough for an agent to judge whether a plan references data the graph actually
 * carries, without dumping every full record. Pure: no DB, no I/O.
 *
 * Shared by both the instance-data and recipe-template summaries; the wrapping
 * header prose and the disclosure-tool {@link EntitySummaryHints} are supplied
 * by each caller.
 */
export function summarizeEntities(entities: ScenarioEntities, hints: EntitySummaryHints): string {
    const entityTypes = Object.keys(entities).sort((left, right) => left.localeCompare(right));
    const shownTypes = entityTypes.slice(0, MAX_ENTITY_TYPES);

    const sections = shownTypes.map((entityType) => summarizeEntityType(entityType, entities[entityType] ?? [], hints));

    if (entityTypes.length > shownTypes.length) {
        sections.push(hints.moreTypes(entityTypes.slice(shownTypes.length)));
    }

    return sections.join("\n");
}

function summarizeEntityType(entityType: string, records: ScenarioEntityRecord[], hints: EntitySummaryHints): string {
    if (records.length === 0) {
        return `### ${entityType} - 0 records`;
    }

    const shown = records.slice(0, MAX_RECORDS_PER_TYPE);
    // Pick fields off the records we actually render, so the scan stays bounded
    // by MAX_RECORDS_PER_TYPE regardless of how many records the type has.
    const identifyingFields = pickIdentifyingFields(shown);

    const lines = [
        `### ${entityType} - ${records.length} record${records.length === 1 ? "" : "s"}`,
        ...(identifyingFields.length > 0
            ? [`Identifying fields: ${identifyingFields.map((field) => `\`${field}\``).join(", ")}`]
            : []),
        ...shown.map((record, index) => formatRecordLine(record, index, identifyingFields)),
    ];

    if (records.length > shown.length) {
        lines.push(hints.moreRecords(entityType, records.length - shown.length));
    }

    return lines.join("\n");
}

function formatRecordLine(record: ScenarioEntityRecord, index: number, identifyingFields: string[]): string {
    const alias = typeof record._alias === "string" && record._alias.length > 0 ? record._alias : `#${index}`;
    const fieldValues = identifyingFields.map((field) => `${field}: ${formatValue(record[field])}`).join(", ");
    return fieldValues.length > 0 ? `- \`${alias}\` - ${fieldValues}` : `- \`${alias}\``;
}

/**
 * Choose up to {@link MAX_IDENTIFYING_FIELDS} scalar fields to display per
 * record: prioritized human-readable names first, then the remaining scalar
 * fields in insertion order. `_alias` and relationship refs (`{ _ref }`) are
 * never identifying values, so they're excluded.
 */
function pickIdentifyingFields(records: ScenarioEntityRecord[]): string[] {
    const candidates: string[] = [];
    for (const record of records) {
        for (const [field, value] of Object.entries(record)) {
            if (field === "_alias") continue;
            if (!isScalar(value)) continue;
            if (!candidates.includes(field)) candidates.push(field);
        }
    }

    const prioritized = IDENTIFYING_FIELD_PRIORITY.filter((field) => candidates.includes(field));
    const rest = candidates.filter((field) => !prioritized.includes(field));
    return [...prioritized, ...rest].slice(0, MAX_IDENTIFYING_FIELDS);
}

function isScalar(value: unknown): value is string | number | boolean {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function formatValue(value: unknown): string {
    if (value === undefined) return "(absent)";
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    if (rendered.length <= MAX_VALUE_CHARS) return rendered;
    return `${rendered.slice(0, MAX_VALUE_CHARS)}...`;
}
