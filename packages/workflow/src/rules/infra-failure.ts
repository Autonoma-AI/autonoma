type ProvisioningCategory = "environment_failure" | "scenario_issue";

/**
 * Words that place a failure in the SDK / scenario / preview world (as opposed to the classifier's own model API,
 * repo clone, etc.). The SDK client tags its HTTP + timeout errors with these ("SDK returned HTTP 500", "SDK call
 * timed out - ensure your endpoint is reachable"), so their presence tells us an ambiguous signal like "timeout"
 * is a provisioning failure and not, say, the LLM endpoint timing out during classification.
 */
const SDK_CONTEXT_MARKERS = ["sdk", "scenario", "preview", "endpoint", "webhook", "provision", "seed"];

/**
 * Transport-level errors that are unambiguously a network failure no matter who raised them - safe to categorize
 * without SDK context (a DNS/connection error to any host is an infra problem, never a classifier logic bug). A
 * peer that drops the connection surfaces under two phrasings, both listed here: Node's "socket hang up" and
 * undici's "other side closed" (the server closed the socket mid-fetch).
 */
const TRANSPORT_ERROR_MARKERS = [
    "econnrefused",
    "econnreset",
    "enotfound",
    "eai_again",
    "getaddrinfo",
    "socket hang up",
    "other side closed",
];

/**
 * Classify an arbitrary error message as an SDK / provisioning / infrastructure failure, or `undefined` when it
 * is not recognizably one. Used only on the classify path - a throw from the model API / video reads / verdict
 * shaping, which carries no structured tag - to tell a preview/scenario outage apart from a genuine classifier
 * bug. STRICT by design: an unrecognized message returns `undefined` so real classifier bugs keep surfacing as
 * `classification_error` instead of being silently buried as "not the PR's fault".
 *
 * (The provisioning path no longer reaches here: a real scenario up/down failure now carries the structured
 * `SdkFailure` tag, which the workflow maps directly; an untagged provisioning throw is our own orchestration and
 * is contained as `engine_artifact` without consulting the message.)
 *
 * Ambiguous signals (an HTTP status, a bare "timeout"/"fetch failed") are only trusted once SDK/scenario/preview
 * context is established by the message naming it - otherwise a model-API timeout during classification would be
 * mislabeled as "the preview was unavailable", so the message has to prove it. Only genuinely transport-level
 * errors (ECONNREFUSED/ENOTFOUND/socket hang up/other side closed) are categorized without any context. In the
 * SDK-context branch:
 * - a 5xx / a failed seed query / a sign-in failure means the endpoint responded but seeding failed (`scenario_issue`);
 * - a 404 / 503 / 504 / timed-out / unreachable endpoint means the preview is missing or unreachable (`environment_failure`).
 */
export function categorizeInfraFailure(message: string): ProvisioningCategory | undefined {
    const normalized = message.toLowerCase();
    const hasSdkContext = SDK_CONTEXT_MARKERS.some((marker) => normalized.includes(marker));

    if (hasSdkContext) {
        const isSeedFailure =
            normalized.includes("http 500") ||
            normalized.includes("http 502") ||
            normalized.includes("failed query") ||
            normalized.includes("statement timeout") ||
            normalized.includes("sign-in failed");
        if (isSeedFailure) return "scenario_issue";

        const isUnreachable =
            normalized.includes("http 404") ||
            normalized.includes("http 503") ||
            normalized.includes("http 504") ||
            normalized.includes("http 408") ||
            normalized.includes("timed out") ||
            normalized.includes("timeout") ||
            normalized.includes("unreachable") ||
            normalized.includes("fetch failed");
        if (isUnreachable) return "environment_failure";
    }

    if (TRANSPORT_ERROR_MARKERS.some((marker) => normalized.includes(marker))) return "environment_failure";

    return undefined;
}
