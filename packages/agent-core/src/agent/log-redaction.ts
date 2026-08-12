/** Above a large text result (a `bash` stdout is ~4 KB), far below inline media. */
const MAX_LOGGED_STRING_CHARS = 4_096;

/** Bounded so a self-referential value cannot spin the logger. */
const MAX_DEPTH = 12;

/**
 * Replace every oversized string in a logged value with a note of its length.
 *
 * A size rule rather than a media rule: the next tool to return something enormous is covered without anyone
 * opting in.
 */
export function redactForLog(value: unknown): unknown {
    return redact(value, 0);
}

function redact(value: unknown, depth: number): unknown {
    if (typeof value === "string") {
        return value.length > MAX_LOGGED_STRING_CHARS ? `[${value.length} chars elided]` : value;
    }
    if (value == null || typeof value !== "object") return value;
    if (depth >= MAX_DEPTH) return "[nesting elided]";

    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

    // Serializes to one JSON number per byte - worse than the base64 this exists to catch.
    if (ArrayBuffer.isView(value)) return `[${value.byteLength} bytes elided]`;

    // Walking an Error or a Date would flatten away the serialization it carries (an Error to `{}`).
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;

    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, depth + 1)]));
}
