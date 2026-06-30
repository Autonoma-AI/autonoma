/**
 * Thrown by `SdkClient` when the customer-deployed Autonoma SDK endpoint returns
 * a non-2xx status. Carries the HTTP `status` (and the extracted `detail`, when
 * present) as structured fields so callers can branch on the status without
 * parsing the message string.
 *
 * The motivating case: a managed (PreviewKit) discover that 401s is our own
 * shared-secret drift, not a customer failure, so the caller self-heals on
 * `err.status === 401` rather than surfacing a hard error.
 */
export class SdkHttpError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly detail?: string,
    ) {
        super(message);
        this.name = "SdkHttpError";
    }
}
