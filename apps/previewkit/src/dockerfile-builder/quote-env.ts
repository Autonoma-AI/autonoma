/**
 * Quotes a value for a Dockerfile `ENV` line: wraps in double quotes and
 * escapes the three characters special inside them (backslash, double quote,
 * dollar). Values are expected to be single-line.
 */
export function quoteEnv(value: string): string {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
    return `"${escaped}"`;
}
