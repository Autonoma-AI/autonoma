import { isColdStartMessage, isColdStartStatus, sdkErrorStatus } from "@autonoma/types";

/**
 * What a failed SDK validation is asking of the user.
 *
 * `fixable` - the endpoint answered and its answer was wrong: a route that is not mounted, a
 * handler that rejects our signature, a factory that is missing. That is a change in their repo,
 * which is exactly what a coding agent can make.
 *
 * `transient` - nothing answered: a scaled-to-zero preview still waking up, or one that hung. There
 * is no code to fix, so pointing an agent at it wastes a session; the answer is to wait and retry.
 */
export type SdkValidationErrorKind = "fixable" | "transient";

/**
 * Signals of an endpoint that never answered, for a message carrying no HTTP status: the SDK
 * client's own timeout wording, and the "Unexpected token '<' ... is not valid JSON" a proxy 504
 * yields when it cuts the request and returns an HTML error page. Same signals the test-user
 * provision banner reads as "still waking up".
 */
const UNRESPONSIVE_PATTERNS = [/timed out/i, /not valid JSON/i, /Unexpected token/i, /timeout/i];

export function classifySdkValidationError(message: string): SdkValidationErrorKind {
    // Status first: a 404 serves an HTML page, so it ALSO reads as a JSON parse error. The status
    // is the stronger signal - something answered, and what it said was wrong.
    const status = sdkErrorStatus(message);
    if (status != null) return isColdStartStatus(status) ? "transient" : "fixable";

    if (isColdStartMessage(message)) return "transient";
    if (UNRESPONSIVE_PATTERNS.some((pattern) => pattern.test(message))) return "transient";

    // Everything else got far enough to be the handler's own fault - a discover response that
    // failed schema validation being the common one.
    return "fixable";
}
