/**
 * The signatures that tell a failed call to a customer's Autonoma SDK endpoint apart from a
 * preview that simply was not awake yet.
 *
 * Both the server (which retries a cold endpoint) and the UI (which decides whether a failure is
 * worth handing to a coding agent) have to agree on this, so the codes and patterns live here
 * rather than being listed twice.
 */

/**
 * Gateway statuses an ingress returns while a scaled-to-zero ("serverless") preview
 * is waking up - the request itself wakes the pod, so a retry usually lands warm.
 */
const COLD_START_STATUS_CODES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Connection-level failures from an SDK endpoint whose pod is not accepting
 * connections yet. `SdkClient` folds undici's `error.cause` into the message, so a
 * refused/reset connection reads "fetch failed: connect ECONNREFUSED ..." and the
 * specific reasons below match (not just the generic "fetch failed"). Kept to FAST
 * failures only: a timeout is deliberately excluded (it burns the full request
 * budget and is more likely a hung endpoint than a cold one), so retrying it would
 * blow past a bounded retry schedule.
 */
const COLD_START_MESSAGE_PATTERNS = [/ECONNREFUSED/i, /ECONNRESET/i, /socket hang up/i, /fetch failed/i];

/** Whether an HTTP status is one an ingress returns for a preview that is still waking up. */
export function isColdStartStatus(status: number): boolean {
    return COLD_START_STATUS_CODES.has(status);
}

/**
 * Whether an error MESSAGE carries a cold-start signature. Used when the original
 * error object is gone and only a persisted string remains (e.g.
 * `scenarioInstance.lastError`, which the SDK client formats as "SDK returned HTTP
 * <code>: ..."), or when the message crossed a wire into the browser.
 */
export function isColdStartMessage(message: string): boolean {
    for (const code of COLD_START_STATUS_CODES) {
        if (message.includes(`HTTP ${code}`)) return true;
    }
    return COLD_START_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The HTTP status an SDK error message reports, when it carries one. `SdkClient` formats every
 * non-2xx answer as "SDK returned HTTP <code>[: detail]", so this is how a caller holding only the
 * persisted string recovers the status - which is what separates "your handler answered, and its
 * answer is wrong" from "nothing answered at all".
 */
export function sdkErrorStatus(message: string): number | undefined {
    const match = /\bHTTP (\d{3})\b/.exec(message);
    if (match?.[1] == null) return undefined;
    return Number(match[1]);
}
