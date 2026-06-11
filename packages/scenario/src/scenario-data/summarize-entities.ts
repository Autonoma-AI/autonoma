import type { ScenarioEntities, ScenarioEntityRecord } from "./types";

const MAX_RECORDS_PER_TYPE = 20;
const MAX_ENTITY_TYPES = 30;
const MAX_IDENTIFYING_FIELDS = 2;
const MAX_VALUE_CHARS = 80;

const IDENTIFYING_FIELD_PRIORITY = ["name", "title", "email", "username", "handle", "slug", "label", "key", "id"];

export interface EntitySummaryHints {
    moreRecords: (entityType: string, remaining: number) => string;
    moreTypes: (remainingTypes: string[]) => string;
}

/**
 * Render the bounded, human-legible body of an entity graph: for each entity
 * type, the count, each record's `_alias`, and 1-2 identifying field values.
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
