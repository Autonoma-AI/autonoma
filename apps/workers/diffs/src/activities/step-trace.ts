import { z } from "zod";

/** What the step was aimed at (a described element, an assertion, a URL). Long enough for a full assertion. */
const MAX_TARGET_CHARS = 200;
/** The assertion breakdown or a read's value. The densest part of the line, so the loosest cap. */
const MAX_DETAIL_CHARS = 400;
/** The engine's own error for the step. */
const MAX_ERROR_CHARS = 300;
/** Typed text, kept short: enough to see the WRONG value was entered, not to transcribe a payload. */
const MAX_TYPED_CHARS = 80;

/**
 * The step's inputs as the engine recorded them. Every field is optional because the shape varies by
 * interaction - a click describes an element, an assert carries an instruction, a navigate carries a URL.
 */
const stepParamsSchema = z.object({
    description: z.string().optional(),
    instruction: z.string().optional(),
    condition: z.string().optional(),
    url: z.string().optional(),
    text: z.string().optional(),
});

/** One sub-assertion of an `assert` step: what was checked, and whether it actually held. */
const assertionResultSchema = z.object({
    assertion: z.string(),
    metCondition: z.boolean().optional(),
});

const stepOutputSchema = z.object({
    outcome: z.string().optional(),
    results: z.array(assertionResultSchema).optional(),
});

export interface TracedAttempt {
    order: number;
    interaction: string;
    status: string;
    error: string | null;
    params: object | null;
    output: object | null;
    createdAt: Date;
}

/**
 * The step-by-step trace the classifier reasons from - one line per attempt, in the order the prompt and
 * `view_step_details` both address by `order`.
 *
 * Each line carries four things the classifier cannot otherwise get:
 * - WHEN, as an offset from the run's start, so a scan that reports "after the 2nd message was sent" and a log
 *   line from `get_app_logs` (queried over the same window) can both be pinned to a step;
 * - WHAT the step was aimed at, from the engine's own description of the element / assertion / URL;
 * - for an `assert`, the individual assertions and whether each held - the prompt asks the model to judge
 *   whether a test's assertions were too WEAK to catch a break, which is unanswerable without their text;
 * - the engine's per-step error.
 *
 * A click's or type's `outcome` is deliberately dropped: it restates the coordinates ("Clicked at (959.5,
 * 644.5)"), which say nothing the description does not and which already ride the structured run trace for
 * the UI's overlay.
 */
export function buildStepTrace(attempts: TracedAttempt[], runStartedAt: Date): string[] {
    return attempts.map((attempt) => {
        const parts = [`${attempt.order}. +${offsetFrom(runStartedAt, attempt.createdAt)}`];
        parts.push(`[${attempt.interaction}] ${attempt.status}`);

        const target = describeTarget(attempt);
        if (target != null) parts.push(target);

        const detail = describeOutcome(attempt);
        if (detail != null) parts.push(detail);

        const line = parts.join(" · ");
        if (attempt.error == null) return line;
        return `${line} - ERROR: ${attempt.error.slice(0, MAX_ERROR_CHARS)}`;
    });
}

/** `M:SS` from the run's start. Minutes are not zero-padded - a run is minutes long, never hours. */
function offsetFrom(runStartedAt: Date, at: Date): string {
    const totalSeconds = Math.max(0, Math.round((at.getTime() - runStartedAt.getTime()) / 1000));
    const seconds = totalSeconds % 60;
    return `${Math.floor(totalSeconds / 60)}:${seconds.toString().padStart(2, "0")}`;
}

/** What the step aimed at, plus the typed value for a `type` - the engine's words, not a reconstruction. */
function describeTarget(attempt: TracedAttempt): string | undefined {
    const parsed = stepParamsSchema.safeParse(attempt.params);
    if (!parsed.success) return undefined;

    const params = parsed.data;
    const aim = params.description ?? params.instruction ?? params.condition ?? params.url;
    if (aim == null) return undefined;

    const target = aim.slice(0, MAX_TARGET_CHARS);
    if (params.text == null || params.text === "") return target;
    return `${target} <- "${params.text.slice(0, MAX_TYPED_CHARS)}"`;
}

/** The assertion breakdown for an `assert`, or a `read`'s value. Nothing for the rest - see {@link buildStepTrace}. */
function describeOutcome(attempt: TracedAttempt): string | undefined {
    const parsed = stepOutputSchema.safeParse(attempt.output);
    if (!parsed.success) return undefined;

    const { outcome, results } = parsed.data;
    if (results != null && results.length > 0) {
        const checks = results.map((result) => `${describeMet(result.metCondition)}: ${result.assertion}`).join("; ");
        return `checks: ${checks.slice(0, MAX_DETAIL_CHARS)}`;
    }

    if (attempt.interaction === "read" && outcome != null) return outcome.slice(0, MAX_DETAIL_CHARS);
    return undefined;
}

/**
 * Whether one sub-assertion held, as three states rather than two.
 *
 * `metCondition` is optional in the engine's output, and folding an absent value into "met" would tell the
 * model an assertion PASSED on no evidence - in the one line it uses to judge whether a test's assertions
 * were too weak to catch the break. An unknown result has to read as unknown.
 */
function describeMet(metCondition: boolean | undefined): string {
    if (metCondition == null) return "UNKNOWN";
    return metCondition ? "met" : "NOT MET";
}
