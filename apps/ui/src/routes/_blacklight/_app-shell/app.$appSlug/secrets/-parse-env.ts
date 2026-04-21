export interface ParsedEnvEntry {
    key: string;
    value: string;
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

/**
 * Parses a `.env`-style string into key/value pairs.
 *
 * - Skips blank lines and `#` comments.
 * - Supports optional `export ` prefix (as in shell files).
 * - Strips surrounding single or double quotes from values.
 * - Returns only entries whose line matches the standard `KEY=value` shape.
 */
export function parseEnv(input: string): ParsedEnvEntry[] {
    const entries: ParsedEnvEntry[] = [];
    for (const rawLine of input.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#")) continue;

        const match = ENV_LINE.exec(line);
        if (match == null) continue;

        const key = match[1];
        if (key == null) continue;

        const value = stripQuotes(match[2] ?? "");
        entries.push({ key, value });
    }
    return entries;
}

/**
 * Returns true if the input looks like a multi-line `.env` blob -
 * at least one line must match the `KEY=value` shape.
 */
export function looksLikeEnvFile(input: string): boolean {
    if (!input.includes("\n") && !input.includes("=")) return false;
    return parseEnv(input).length > 0;
}

function stripQuotes(value: string): string {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return value.slice(1, -1);
        }
    }
    return value;
}
