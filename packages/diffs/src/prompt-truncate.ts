/**
 * How much of a prior report to carry as context before truncating. Shared by the Reporter's prompt and the
 * Impact Analysis selector's prompt - both render the branch's report history, and both cut it at this one bound.
 */
export const MAX_PRIOR_REPORT_CHARS = 2_000;

/**
 * Cap `text` to `max` characters, appending a `...[truncated]` marker when it overflows; returns the input
 * unchanged when it already fits. Shared by the two in-package prompt builders (the Reporter's and the selector's),
 * which both render the branch's report history. Distinct from the agent tools' head+tail `truncateOutput`, which
 * keeps both ends for a different purpose.
 */
export function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}...[truncated]`;
}
