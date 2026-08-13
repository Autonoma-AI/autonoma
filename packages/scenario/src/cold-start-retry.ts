import type { Logger } from "@autonoma/logger";
import { isColdStartFailure, isColdStartMessage } from "@autonoma/types";
import { sleep as defaultSleep } from "@autonoma/utils/sleep";
import { SdkCallError } from "./sdk-call-error";

// The signatures themselves live in `@autonoma/types`, because the UI classifies a persisted
// failure message with the same rules this retry loop uses.
export { isColdStartMessage } from "@autonoma/types";

/**
 * Backoff between cold-start retries, in ms. The length is the number of retries
 * AFTER the first attempt; the total (~32s here) is deliberately kept under a
 * minute so a still-cold endpoint fails within a caller's request budget.
 */
const DEFAULT_COLD_START_DELAYS_MS = [2_000, 5_000, 10_000, 15_000];

/**
 * Whether an error is the signature of a scaled-to-zero preview waking up (a 502/503/504 from the ingress, or a
 * refused/reset/dropped connection), as opposed to a genuine failure. A real 4xx/5xx from the app, a bad response,
 * or a timeout are NOT cold starts - retrying those just fails the same way (or wastes the budget).
 *
 * Every `SdkClient` throw carries the structured `SdkFailure` tag, so the rule reads that one source of truth
 * (shared with the analysis workflow and the dry-run path); only a non-SDK error falls back to sniffing the message.
 */
export function isColdStartError(err: unknown): boolean {
    if (err instanceof SdkCallError) return isColdStartFailure(err.failure);
    if (err instanceof Error) return isColdStartMessage(err.message);
    return false;
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
