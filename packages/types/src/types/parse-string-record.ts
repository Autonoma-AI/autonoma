/**
 * Coerces a stored JSON object (e.g. a preview environment's `urls` map or an addon's outputs) into a sorted
 * string->string record, dropping non-string and empty values. Anything that is not a plain object reads as empty.
 */
export function parseStringRecord(value: unknown): Record<string, string> {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
            .sort(([a], [b]) => a.localeCompare(b)),
    );
}
