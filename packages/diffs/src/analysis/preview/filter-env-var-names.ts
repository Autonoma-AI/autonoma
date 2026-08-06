/** Case-insensitive substring match; an absent or empty filter keeps every name. Shared with the eval replay. */
export function filterEnvVarNames(names: readonly string[], filter?: string): string[] {
    if (filter == null || filter === "") return [...names];
    const needle = filter.toLowerCase();
    return names.filter((name) => name.toLowerCase().includes(needle));
}
