import { SdkCallError } from "./sdk-call-error";

/**
 * Thrown by `SdkClient` when the customer-deployed Autonoma SDK endpoint returns a non-2xx status. Carries the HTTP
 * `status`, the SDK's contractual error `code` (when the body carried one), and the extracted `detail` as
 * structured fields so callers can branch on them without parsing the message string, and carries the same facts
 * as an `SdkFailure` tag on its `SdkCallError` base for the analysis workflow.
 *
 * The motivating case: a managed (PreviewKit) discover that 401s is our own shared-secret drift, not a customer
 * failure, so the caller self-heals on `err.status === 401` rather than surfacing a hard error.
 */
export class SdkHttpError extends SdkCallError {
    constructor(
        public readonly status: number,
        message: string,
        public readonly code?: string,
        public readonly detail?: string,
    ) {
        super(message, { kind: "http", status, code });
        this.name = "SdkHttpError";
    }
}
