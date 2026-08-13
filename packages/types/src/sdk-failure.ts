import { z } from "zod";
import type { AnalysisVerdict } from "./schemas/analysis";
import { isColdStartStatus } from "./sdk-error-signals";

/**
 * The SDK error codes this monorepo keys on by name - the two ownership overrides in `mapSdkFailureToVerdict`, and
 * the HMAC-drift signal the onboarding self-heal detects. Mirrored from the customer SDK's `AutonomaError` codes: a
 * cross-language contract fixed by the SDK repo's `protocol/suites/errors.test.json`, which this monorepo does not
 * import. Exported so every reader shares one definition - a rename then lands in one place - and the conformance
 * suite keeps this copy in sync.
 * - `INVALID_BODY`: WE sent a request the SDK could not parse - our client/recipe bug, not the customer's.
 * - `INVALID_SIGNATURE`: HMAC drift, almost always our managed shared secret - genuinely either side, so undecided.
 */
export const SDK_ERROR_CODE = {
    INVALID_BODY: "INVALID_BODY",
    INVALID_SIGNATURE: "INVALID_SIGNATURE",
} as const;

/**
 * The structured signal for a failed call to a customer's Autonoma SDK endpoint, computed at the transport
 * boundary (`SdkClient`) while the real error object - the undici `cause`, the timeout flag, the HTTP status and
 * body `code` - is still alive, then carried unflattened to the analysis workflow.
 *
 * It is MECHANISM-shaped, not verdict-shaped: it says what happened at the wire, never whose fault it is. The
 * transport layer must not know the `AnalysisVerdict` vocabulary (ownership needs context it does not have - a 401
 * is ours on a managed preview and the customer's on a self-hosted one), so `mapSdkFailureToVerdict` decides the
 * verdict above it. The `http` variant carries the raw `status` + `code` rather than pre-bucketing, so a new
 * status rule is a mapping change, not a schema change.
 */
export const sdkFailureSchema = z.discriminatedUnion("kind", [
    /** A transport-level failure - the connection was refused, reset, or dropped, or DNS did not resolve. */
    z.object({ kind: z.literal("unreachable") }),
    /** The request exceeded its deadline (`AbortSignal.timeout`) - the endpoint hung or was too slow. */
    z.object({ kind: z.literal("timed_out") }),
    /** The endpoint answered with a non-2xx. `code` is the SDK's contractual error code, present when the body carried one. */
    z.object({ kind: z.literal("http"), status: z.number().int(), code: z.string().optional() }),
    /** A 2xx whose body failed the up/down response schema - the SDK claimed success but its answer is malformed. */
    z.object({ kind: z.literal("bad_response") }),
]);
export type SdkFailure = z.infer<typeof sdkFailureSchema>;

/**
 * The Temporal `ApplicationFailure.type` the scenario provisioning activity stamps a failure with, so the analysis
 * workflow can find the failure carrying an `SdkFailure` in its `details` amid the generic wrapper chain. Shared
 * between the activity that sets it and the workflow that reads it.
 */
export const SCENARIO_SETUP_FAILURE_TYPE = "ScenarioSetupFailed";

/**
 * Which coverage-plane `AnalysisVerdict` an SDK provisioning failure resolves to. The organizing principle: a valid
 * SDK `code` means the customer's handler answered (its factory/contract - the scenario plane); no `code` means an
 * ingress/proxy answered or nothing did (the environment plane). Two codes override that split - see `SDK_ERROR_CODE`.
 *
 * Never returns `engine_artifact` for a reached-endpoint failure: that verdict is the workflow's fallback for a
 * throw that never came from the SDK call at all (our orchestration), which by definition has no `SdkFailure`.
 */
export function mapSdkFailureToVerdict(failure: SdkFailure): AnalysisVerdict {
    switch (failure.kind) {
        case "unreachable":
        case "timed_out":
            return "environment_failure";
        case "bad_response":
            return "scenario_issue";
        case "http":
            return mapHttpFailure(failure.status, failure.code);
    }
}

/**
 * Whether a structured {@link SdkFailure} carries a cold-start signature - a scaled-to-zero preview waking up. The
 * tag-native counterpart of {@link isColdStartMessage}, for a caller that has the structured failure rather than
 * only the persisted message: a connection-level `unreachable` or a gateway 502/503/504 is a cold start; a timeout
 * (it burns the full budget, more likely a hung endpoint than a cold one), a bad response, or any other HTTP status
 * is not.
 */
export function isColdStartFailure(failure: SdkFailure): boolean {
    if (failure.kind === "unreachable") return true;
    if (failure.kind === "http") return isColdStartStatus(failure.status);
    return false;
}

function mapHttpFailure(status: number, code: string | undefined): AnalysisVerdict {
    if (code === SDK_ERROR_CODE.INVALID_BODY) return "engine_artifact";
    if (code === SDK_ERROR_CODE.INVALID_SIGNATURE) return "environment_failure";
    // A gateway/ingress status or a missing endpoint is the environment, not the app - the handler never answered.
    if (isColdStartStatus(status) || status === 404) return "environment_failure";
    // Any other code is the customer's handler rejecting or erroring on the request; a bare status is the ingress.
    return code != null ? "scenario_issue" : "environment_failure";
}
