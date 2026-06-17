/**
 * Renders a compiled PreviewKit config document as `.preview.yaml` text. The
 * YAML panel is a generated artifact (copy/download), never an editing surface,
 * so this emitter only needs to cover the document shapes the topology builder
 * compiles plus round-tripped passthrough fields.
 */
export function toPreviewYaml(document: Record<string, unknown>): string {
    const lines: string[] = [];
    const order = ["version", "domain", "registry", "config", "apps", "services", "addons", "hooks"];
    const keys = [
        ...order.filter((key) => key in document),
        ...Object.keys(document).filter((key) => !order.includes(key)),
    ];

    for (const key of keys) {
        const value = document[key];
        if (isEmptyValue(value)) continue;
        if (
            lines.length > 0 &&
            (key === "apps" || key === "services" || key === "addons" || key === "hooks" || key === "config")
        ) {
            lines.push("");
        }
        emitEntry(lines, key, value, 0);
    }

    return `${lines.join("\n")}\n`;
}

function isEmptyValue(value: unknown): boolean {
    if (value == null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value).length === 0;
    return false;
}

function emitEntry(lines: string[], key: string, value: unknown, depth: number): void {
    const indent = "  ".repeat(depth);

    if (Array.isArray(value)) {
        lines.push(`${indent}${key}:`);
        for (const item of value) {
            emitArrayItem(lines, item, depth + 1);
        }
        return;
    }

    if (typeof value === "object" && value != null) {
        const entries = Object.entries(value).filter(([, entryValue]) => !isEmptyValue(entryValue));
        if (entries.length === 0) return;
        lines.push(`${indent}${key}:`);
        for (const [entryKey, entryValue] of entries) {
            emitEntry(lines, entryKey, entryValue, depth + 1);
        }
        return;
    }

    lines.push(`${indent}${key}: ${formatScalar(value, key)}`);
}

function emitArrayItem(lines: string[], item: unknown, depth: number): void {
    const indent = "  ".repeat(depth);

    if (typeof item !== "object" || item == null) {
        lines.push(`${indent}- ${formatScalar(item, "")}`);
        return;
    }

    const entries = Object.entries(item).filter(([, value]) => !isEmptyValue(value));
    if (entries.length === 0) {
        lines.push(`${indent}- {}`);
        return;
    }

    entries.forEach(([key, value], index) => {
        if (index === 0 && (typeof value !== "object" || value == null)) {
            lines.push(`${indent}- ${key}: ${formatScalar(value, key)}`);
            return;
        }
        if (index === 0) {
            lines.push(`${indent}-`);
        }
        if (typeof value === "object" && value != null) {
            emitEntry(lines, key, value, depth + 1);
        } else {
            lines.push(`${indent}  ${key}: ${formatScalar(value, key)}`);
        }
    });
}

const PLAIN_SCALAR_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const ALWAYS_QUOTED_KEYS = new Set(["version_", "pattern", "replacement"]);

function formatScalar(value: unknown, key: string): string {
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value !== "string") return JSON.stringify(value);
    if (value === "") return '""';
    if (ALWAYS_QUOTED_KEYS.has(key)) return JSON.stringify(value);
    if (PLAIN_SCALAR_PATTERN.test(value) && !/^\d+$/.test(value)) return value;
    return JSON.stringify(value);
}
