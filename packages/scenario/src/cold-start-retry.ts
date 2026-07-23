import type { Logger } from "@autonoma/logger";
import { sleep as defaultSleep } from "@autonoma/utils/sleep";
import { SdkHttpError } from "./sdk-http-error";

/**
 * Gateway statuses an ingress returns while a scaled-to-zero ("serverless") preview
 * is waking up - the request itself wakes the pod, so a retry usually lands warm.
 */
const COLD_START_STATUS_CODES = new Set([502, 503, 504]);

/**
 * Connection-level failures from an SDK endpoint whose pod is not accepting
 * connections yet. `SdkClient` folds undici's `error.cause` into the message, so a
 * refused/reset connection reads "fetch failed: connect ECONNREFUSED ..." and the
 * specific reasons below match (not just the generic "fetch failed"). Kept to FAST
 * failures only: a timeout is deliberately excluded (it burns the full request
 * budget and is more likely a hung endpoint than a cold one), so retrying it would
 * blow past the bounded schedule below.
 */
const COLD_START_MESSAGE_PATTERNS = [/ECONNREFUSED/i, /ECONNRESET/i, /socket hang up/i, /fetch failed/i];

/**
 * Backoff between cold-start retries, in ms. The length is the number of retries
 * AFTER the first attempt; the total (~32s here) is deliberately kept under a
 * minute so a still-cold endpoint fails within a caller's request budget.
 */
const DEFAULT_COLD_START_DELAYS_MS = [2_000, 5_000, 10_000, 15_000];

/**
 * Whether an error is the signature of a scaled-to-zero preview waking up (a
 * 502/503/504 from the ingress, or a connection refused/reset), as opposed to a
 * genuine failure. A real 4xx/5xx from the app, a bad response, or a timeout are
 * NOT cold starts - retrying those just fails the same way (or wastes the budget).
 */
export function isColdStartError(err: unknown): boolean {
    if (err instanceof SdkHttpError) return COLD_START_STATUS_CODES.has(err.status);
    if (err instanceof Error) return isColdStartMessage(err.message);
    return false;
}

/**
 * Whether an error MESSAGE carries a cold-start signature. Used when the original
 * error object is gone and only a persisted string remains (e.g.
 * `scenarioInstance.lastError`, which the SDK client formats as "SDK returned HTTP
 * <code>: ..."). Derives from the same status codes / patterns as
 * {@link isColdStartError} so the two never drift.
 */
export function isColdStartMessage(message: string): boolean {
    for (const code of COLD_START_STATUS_CODES) {
        if (message.includes(`HTTP ${code}`)) return true;
    }
    return COLD_START_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export interface ColdStartRetryOptions {
    logger: Logger;
    /** Backoff schedule; its length is the number of retries after the first attempt. Defaults to ~32s over 4 retries. */
    delaysMs?: number[];
    /** Injectable for tests so they don't wait real time; defaults to the shared `@autonoma/utils` sleep. */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `work`, retrying ONLY when it fails with a {@link isColdStartError cold-start
 * signal}. The first attempt itself wakes a scaled-to-zero preview, so a short
 * backoff usually lands a warm retry. Any non-cold-start error throws immediately -
 * we never retry a genuine failure. If the endpoint is still cold after the whole
 * schedule, the last cold-start error is re-thrown for the caller to surface.
 */
export async function withColdStartRetry<T>(work: () => Promise<T>, options: ColdStartRetryOptions): Promise<T> {
    const { logger, delaysMs = DEFAULT_COLD_START_DELAYS_MS, sleep = defaultSleep } = options;
    let lastError: unknown;
    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
        try {
            return await work();
        } catch (err) {
            if (!isColdStartError(err)) throw err;
            lastError = err;
            if (attempt === delaysMs.length) break;
            const delayMs = delaysMs[attempt] ?? 0;
            logger.info("SDK endpoint appears cold, waiting before retry", {
                extra: { attempt: attempt + 1, delayMs, error: err instanceof Error ? err.message : String(err) },
            });
            await sleep(delayMs);
        }
    }
    throw lastError;
}
