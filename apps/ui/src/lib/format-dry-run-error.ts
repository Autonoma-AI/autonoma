/** One scenario dry-run attempt as the UI renders it: whether it passed, where it failed, and why. */
export interface DryRunOutcome {
    success: boolean;
    phase?: string;
    /** Why it failed. Absent when it passed, or when nothing said why. */
    error?: string;
}

/**
 * Render why a scenario dry run failed, from either way one can end.
 *
 * The procedure RESOLVES with `success: false` when the SDK ran and rejected the data - that
 * carries a structured error, typed `unknown` over the wire. It THROWS when the run never got
 * that far, most often because the recipe could not resolve; that case produces no scenario
 * instance and no preview logs, so this string is the only evidence there is of what happened
 * and must not be dropped on the floor.
 */
export function formatDryRunError(error: unknown): string | undefined {
    if (error == null) return undefined;
    if (typeof error === "string") return error.length > 0 ? error : undefined;
    if (error instanceof Error) return error.message;
    return JSON.stringify(error);
}
