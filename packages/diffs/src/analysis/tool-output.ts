/**
 * Bound the tool output an investigation run feeds back to the model. The AI SDK keeps every prior tool result
 * in the messages array, and the agent runs 40-60 tool steps, so unbounded results accumulate until the prompt
 * blows past the model's token limit. In prod this surfaced as `AI_APICallError: context_length_exceeded`
 * (~1M tokens vs a 922k cap) and as 5-min-x-3-retry timeouts while the model churned through the oversized
 * context. The blowup is driven by ACCUMULATION across steps, not by any single read - so a big source file can
 * still be read in full early in a run; the budget only clamps down once the run's total context is filling up.
 *
 * Two overflow modes:
 * - "narrow": for read-only, freely re-issuable tools (read_code, grep_code, git_diff, get_test_plan). We DROP
 *   the oversized result and hand back a nudge telling the model the result was too large and to re-call the
 *   tool scoped to just the part it needs. The model chooses the narrower scope, so we never replay anything.
 * - "truncate": for tools we must NOT ask the model to re-run - run_script can carry non-idempotent operations
 *   (e.g. a scenario `up`), and the vision calls are expensive. We keep head+tail and mark the omission.
 */
const APPROX_CHARS_PER_TOKEN = 4;

/** Always leave room for at least a small read even when the run's budget is nearly spent. */
const MIN_PER_CALL_CHARS = 4_000;

/** Default per-run cumulative ceiling for ALL tool output, leaving the rest of the ~922k-token window for the
 * base prompt, the inlined catalog, images, and the model's own output. ~150k tokens of tool results. */
export const DEFAULT_TOTAL_TOOL_OUTPUT_CHARS = 600_000;

export type ToolCap = (
    output: string,
    opts: { tool: string; mode: "narrow" | "truncate"; maxChars: number; hint?: string },
) => string;

function capOnce(
    output: string,
    opts: { tool: string; mode: "narrow" | "truncate"; maxChars: number; hint?: string },
): string {
    if (output.length <= opts.maxChars) return output;
    const approxTokens = Math.round(output.length / APPROX_CHARS_PER_TOKEN);

    if (opts.mode === "narrow") {
        const hint = opts.hint != null ? ` ${opts.hint}` : "";
        return (
            `[\`${opts.tool}\` returned ~${approxTokens} tokens - too large to include without exceeding the ` +
            `context window, so it was dropped. Re-call \`${opts.tool}\` scoped to just the part you need:${hint} ` +
            `Request only what you need to read - do not ask to re-run side-effecting operations.]`
        );
    }

    const half = Math.floor(opts.maxChars / 2);
    const omitted = output.length - opts.maxChars;
    return (
        `${output.slice(0, half)}\n\n` +
        `[... ${omitted} chars (~${Math.round(omitted / APPROX_CHARS_PER_TOKEN)} tokens) omitted: this result ` +
        `is too large to show in full; the head and tail are kept ...]\n\n` +
        `${output.slice(output.length - half)}`
    );
}

/**
 * Create a per-run output budget. Returns a `cap` to wrap every tool result: a result is allowed in full up to
 * its own `maxChars` AND whatever cumulative budget remains for the run. Big reads pass early; once the run has
 * spent its budget, further large results are narrowed/truncated. Only the kept text counts against the budget
 * (a dropped "narrow" result costs nothing, so re-calling with a tighter scope is always possible).
 */
export function createToolBudget(totalMaxChars: number = DEFAULT_TOTAL_TOOL_OUTPUT_CHARS): ToolCap {
    let used = 0;
    return (output, opts) => {
        const remaining = Math.max(MIN_PER_CALL_CHARS, totalMaxChars - used);
        const effectiveMax = Math.min(opts.maxChars, remaining);
        const result = capOnce(output, { ...opts, maxChars: effectiveMax });
        used += result.length;
        return result;
    };
}
