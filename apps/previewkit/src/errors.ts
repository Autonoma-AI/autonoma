/**
 * A failure that originates on Autonoma's own infrastructure - Kubernetes, AWS,
 * the deploy control plane - rather than in the customer's app or build. Examples:
 * an ExternalSecret that never syncs, a volume that won't mount, a pod that can't
 * be scheduled for lack of capacity.
 *
 * These are Autonoma bugs, not something the user can act on, and the raw cluster
 * text (namespace names, CR kinds, internal identifiers) is noise to them at best.
 * The runner logs a `PreviewPlatformError` fatal with its full detail for us and
 * records a generic message for the customer instead of leaking the raw error.
 *
 * Throw this from infra operations only. A build failure or a container that exits
 * non-zero reflects the customer's code - those stay plain errors and their real
 * message is surfaced as-is.
 */
export class PreviewPlatformError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "PreviewPlatformError";
    }
}
