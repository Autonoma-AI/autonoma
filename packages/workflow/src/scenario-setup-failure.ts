import type { InvestigationTestResult, InvestigationVerdict } from "./activities";

/**
 * Build the result for a shadow test whose `scenario up` failed before the app could be exercised. Mirrors the
 * diffs generation path (mark the setup failed and skip the run) - we do NOT launch a browser or invoke the
 * classifier when provisioning never produced a usable environment. Crucially, we attach a real verdict with a
 * provisioning category so the report attributes the failure to the environment/scenario, NOT to a
 * `classification_error` (a missing-verdict result renders as "classification error", which is how these
 * `scenario up` failures were being mislabeled and hidden).
 *
 * The category split is a deterministic heuristic keyed off the SDK error: a 5xx from the seeding call means
 * the endpoint responded but provisioning the data failed (a recipe/scenario problem), while a 404 / timeout /
 * unreachable endpoint means the preview deployment itself is missing (an environment problem). When unclear we
 * default to `environment_failure`, the more conservative "not the PR's fault" bucket.
 */
export function scenarioSetupFailureResult(input: { slug: string; message: string }): InvestigationTestResult {
    const category = categorizeScenarioSetupFailure(input.message);
    const isEnvironment = category === "environment_failure";
    const verdict: InvestigationVerdict = {
        category,
        isClientBug: false,
        ran: false,
        confidence: "high",
        planFidelity: "diverged",
        headline: isEnvironment
            ? "Scenario setup failed: the preview environment was unavailable, so the test never ran"
            : "Scenario setup failed: seeding the test data errored, so the test never ran",
        falsePositiveRisk: "None - the test never executed against the app, so this cannot be attributed to the PR.",
        whatHappened: `scenario up failed before the browser was launched: ${input.message}`,
        rootCause: isEnvironment
            ? "The preview deployment / SDK endpoint was missing or unreachable during provisioning."
            : "The scenario seeding call failed, so the required test data was never provisioned.",
        remediation: isEnvironment
            ? "Restore or redeploy the PR preview and confirm the SDK endpoint is reachable, then re-run."
            : "Fix the failing scenario recipe/seed for this app (see the error), then re-run.",
        evidence: [{ source: "run", detail: input.message }],
    };
    return { slug: input.slug, plan: "", runSuccess: false, stepCount: 0, verdict };
}

type ProvisioningCategory = "environment_failure" | "scenario_issue";

/**
 * A `scenario up` failure is ALWAYS a provisioning problem, so map it to the specific bucket when the message
 * makes the cause clear, and to `environment_failure` (the conservative "not the PR's fault" default) otherwise.
 */
function categorizeScenarioSetupFailure(message: string): ProvisioningCategory {
    return categorizeInfraFailure(message) ?? "environment_failure";
}

/**
 * Words that place a failure in the SDK / scenario / preview world (as opposed to the classifier's own model API,
 * repo clone, etc.). The SDK client tags its HTTP + timeout errors with these ("SDK returned HTTP 500", "SDK call
 * timed out - ensure your endpoint is reachable"), so their presence tells us an ambiguous signal like "timeout"
 * is a provisioning failure and not, say, the LLM endpoint timing out during classification.
 */
const SDK_CONTEXT_MARKERS = ["sdk", "scenario", "preview", "endpoint", "webhook", "provision", "seed"];

/**
 * Transport-level errors that are unambiguously a network failure no matter who raised them - safe to categorize
 * without SDK context (a DNS/connection error to any host is an infra problem, never a classifier logic bug).
 */
const TRANSPORT_ERROR_MARKERS = [
    "econnrefused",
    "econnreset",
    "enotfound",
    "eai_again",
    "getaddrinfo",
    "socket hang up",
];

/**
 * Classify an arbitrary error message as an SDK / provisioning / infrastructure failure, or `undefined` when it
 * is not recognizably one. Used to decide whether a throw that escaped the run/classify path is a provisioning
 * failure (attributable to the environment or the scenario recipe, not the PR) rather than a genuine
 * `classification_error`. STRICT by design: an unrecognized message returns `undefined` so real classifier bugs
 * keep surfacing as `classification_error` instead of being silently buried as "not the PR's fault".
 *
 * Ambiguous signals (an HTTP status, a bare "timeout"/"fetch failed") are only trusted when the message also
 * carries SDK/scenario/preview context - otherwise a model-API timeout during classification would be mislabeled
 * as "the preview was unavailable". Only genuinely transport-level errors (ECONNREFUSED/ENOTFOUND/socket hang up)
 * are categorized without that context. In the SDK-context branch:
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

/**
 * Build a categorized result for a shadow test that THREW an SDK / provisioning / infra error somewhere in the
 * run-or-classify path (not the clean `scenario up` guard, which `scenarioSetupFailureResult` covers). Returns
 * `undefined` when the error is not a recognizable infra failure, so the caller keeps the honest
 * `classification_error` for a genuine classifier fault. This is what stops SDK 404/500/503 throws from being
 * buried as "classification error" (~the other half of the failing-ups mislabel).
 */
export function infraFailureResult(input: { slug: string; message: string }): InvestigationTestResult | undefined {
    const category = categorizeInfraFailure(input.message);
    if (category == null) return undefined;

    const isEnvironment = category === "environment_failure";
    const verdict: InvestigationVerdict = {
        category,
        isClientBug: false,
        ran: false,
        confidence: "high",
        planFidelity: "diverged",
        headline: isEnvironment
            ? "SDK/environment error: the preview endpoint was unavailable, so the test produced no usable result"
            : "SDK/scenario error: seeding the test data errored, so the test produced no usable result",
        falsePositiveRisk:
            "None - the failure is an SDK/provisioning error, not something the test observed against the app, so it cannot be attributed to the PR.",
        whatHappened: `an SDK/provisioning error occurred while running or classifying this test: ${input.message}`,
        rootCause: isEnvironment
            ? "The preview deployment / SDK endpoint was missing or unreachable."
            : "The scenario seeding call failed, so the required test data was not available.",
        remediation: isEnvironment
            ? "Restore or redeploy the PR preview and confirm the SDK endpoint is reachable, then re-run."
            : "Fix the failing scenario recipe/seed for this app (see the error), then re-run.",
        evidence: [{ source: "run", detail: input.message }],
    };
    return { slug: input.slug, plan: "", runSuccess: false, stepCount: 0, verdict };
}
