import type { MemoryStore } from "./memory-store";

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

export class UnresolvedVariableError extends Error {
    constructor(variableName: string, availableVariables: string[]) {
        const availableStr = availableVariables.length > 0 ? availableVariables.join(", ") : "none";
        super(`Variable "{{${variableName}}}" is not stored in memory. Available variables: ${availableStr}`);
    }
}

/**
 * Deep-walks a plain JSON-serializable object and replaces `{{variableName}}`
 * patterns in string values with the corresponding value from the MemoryStore.
 *
 * Returns a new object — the original is not mutated.
 * Throws {@link UnresolvedVariableError} if a referenced variable is not in the store.
 */
export function resolveVariables<T>(value: T, memory: MemoryStore): T {
    if (typeof value === "string") {
        return value.replace(VARIABLE_PATTERN, (_match, variableName: string) => {
            const resolved = memory.get(variableName);
            if (resolved == null) {
                throw new UnresolvedVariableError(variableName, Object.keys(memory.getAll()));
            }
            return resolved;
        }) as T;
    }

    if (Array.isArray(value)) {
        return value.map((item) => resolveVariables(item, memory)) as T;
    }

    if (value != null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, resolveVariables(val, memory)])) as T;
    }

    // Primitives (number, boolean, null, undefined) pass through unchanged
    return value;
}
