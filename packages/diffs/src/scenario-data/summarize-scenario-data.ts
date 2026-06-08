import type { ScenarioData, ScenarioEntityRecord } from "./types";

/**
 * Per-type record cap in the inlined summary. The full records for any type are
 * available on demand through the `read_scenario_entities` tool, so the prompt
 * stays bounded even for scenarios that seed hundreds of rows.
 */
const MAX_RECORDS_PER_TYPE = 20;
/**
 * Cap on how many entity types are rendered, so the summary stays bounded even
 * for a graph with a huge number of types. Remaining types are named in a
 * trailing note; the agent can still read any of them via `read_scenario_entities`.
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
 * Render a bounded, human-legible summary of the scenario data for the reviewer
 * prompt. For each entity type it inlines the count, each record's `_alias`, and
 * 1-2 identifying field values - enough for the agent to judge whether the test
 * plan references data the scenario actually created (the core "malformed test
 * depends on data the scenario never generated" signal) without dumping every
 * full record. Pure: no DB, no I/O.
 */
export function summarizeScenarioData(data: ScenarioData): string {
    const entityTypes = Object.keys(data.entities).sort((left, right) => left.localeCompare(right));
    const shownTypes = entityTypes.slice(0, MAX_ENTITY_TYPES);

    const sections = shownTypes.map((entityType) => summarizeEntityType(entityType, data.entities[entityType] ?? []));

    if (entityTypes.length > shownTypes.length) {
        const remaining = entityTypes.slice(shownTypes.length);
        sections.push(
            `### ...and ${remaining.length} more entity types: ${remaining.join(", ")}. Use \`read_scenario_entities\` to read any of them.`,
        );
    }

    return [
        `This run executed against scenario **${data.scenarioName}**, which seeded the data below.`,
        "Use the `read_scenario_entities` tool to read the full records for any type. A test plan that depends on data not listed here (a user, item, or value the scenario never created) is malformed - that points to a stale/incorrect test rather than an application bug.",
        "",
        ...sections,
    ].join("\n");
}

function summarizeEntityType(entityType: string, records: ScenarioEntityRecord[]): string {
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
        lines.push(
            `- ...and ${records.length - shown.length} more. Call \`read_scenario_entities("${entityType}")\` for the full list.`,
        );
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
