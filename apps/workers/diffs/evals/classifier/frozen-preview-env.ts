import { type PreviewEnvAccess, filterEnvVarNames } from "@autonoma/diffs/analysis";

/**
 * Serve `get_preview_env` from a name list frozen at capture. Only the filter runs per call, so this answers
 * byte-identically to a live reader holding the same list - which is what lets a replay grade a verdict that
 * turned on whether some integration key was configured. Whether the list still matches what production read
 * is capture's problem, not this one's.
 */
export function frozenPreviewEnv(names: readonly string[]): PreviewEnvAccess {
    return { getEnvVarNames: async (filter?: string) => filterEnvVarNames(names, filter) };
}
