import type { SdkFailure } from "@autonoma/types";

/**
 * Base error for every failure `SdkClient` raises when a call to the customer's Autonoma SDK endpoint does not
 * succeed. Carries the structured {@link SdkFailure} tag computed at the throw site - where the undici `cause`, the
 * timeout flag and the HTTP status are still alive - so the analysis workflow classifies the failure from the tag
 * rather than re-deriving it from the flattened message string. `SdkHttpError` extends this for the non-2xx case.
 */
export class SdkCallError extends Error {
    constructor(
        message: string,
        public readonly failure: SdkFailure,
    ) {
        super(message);
        this.name = "SdkCallError";
    }
}
