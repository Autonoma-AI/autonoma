import { logger as rootLogger } from "@autonoma/logger";
import { sleep } from "@autonoma/utils/sleep";

/**
 * Provider flakes that are safe to retry verbatim. "corrupted thought signature" is a Gemini
 * reasoning-model quirk (a thought signature from a prior turn fails to validate) - it returns as an
 * error but a fresh resend works. The rest are the usual transient HTTP / network classes.
 */
const TRANSIENT_PATTERNS = [
    "corrupted thought signature",
    "overloaded",
    "rate limit",
    "too many requests",
    "timeout",
    "timed out",
    "aborted",
    "the operation was aborted",
    "econnreset",
    "etimedout",
    "fetch failed",
    "socket hang up",
    // The model finished its tool loop but emitted no parseable structured output (Output.object /
    // generateObject). It's a model hiccup, not a logic error - a plain resend almost always works.
    "no output generated",
    "no object generated",
    "503",
    "502",
    "500",
    "429",
    "529",
];

/** AI SDK error classes that mean "the model produced nothing usable" - safe to resend (matched by .name). */
const TRANSIENT_ERROR_NAMES = ["AI_NoOutputGeneratedError", "AI_NoObjectGeneratedError"];

/**
 * Errors that are pointless to retry verbatim - the same request will fail the same way. A context-window
 * overflow is the case that bit us in prod: the per-tool/per-run output budgets (tool-output.ts) should keep
 * the prompt under the limit, but if one still slips through we must fail FAST, not spend three more attempts
 * (~15 min) re-sending the same too-large prompt. Checked first so it wins even if the message also happens to
 * contain a "transient"-looking word.
 */
const PERMANENT_PATTERNS = [
    "context_length_exceeded",
    "context length",
    "maximum context",
    "reduce the length of the messages",
    "exceed the configured limit",
    "string too long",
];

function isPermanent(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return PERMANENT_PATTERNS.some((pattern) => message.includes(pattern));
}

function isTransient(error: unknown): boolean {
    if (isPermanent(error)) return false;
    if (error instanceof Error && TRANSIENT_ERROR_NAMES.includes(error.name)) return true;
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return TRANSIENT_PATTERNS.some((pattern) => message.includes(pattern));
}

const DEFAULT_TRIES = 3;
const MAX_BACKOFF_MS = 10_000;
const BASE_BACKOFF_MS = 2000;

/**
 * Retry a model call on transient provider flakes (e.g. Gemini "corrupted thought signature", 5xx, rate
 * limits) with exponential backoff. Non-transient errors throw immediately; transient ones throw only
 * after the last try.
 *
 * WARNING: classifying transience by substring-matching the error MESSAGE is brittle - it can both
 * over-retry (a message coincidentally containing "timeout") and under-retry (a transient error whose
 * wording we don't list). It's a pragmatic stopgap. If this misfires in practice, replace it with
 * structured error typing from the AI SDK (status codes / error classes) rather than string matching.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts?: { tries?: number; label?: string }): Promise<T> {
    const tries = opts?.tries ?? DEFAULT_TRIES;
    const logger = rootLogger.child({ name: "withRetry" });
    let lastError: unknown;
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (!isTransient(error) || attempt === tries) throw error;
            const delayMs = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
            logger.warn("Transient model error - retrying", {
                extra: { attempt, tries, label: opts?.label, delayMs },
                err: error instanceof Error ? error.message : String(error),
            });
            await sleep(delayMs);
        }
    }
    throw lastError;
}
