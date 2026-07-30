import { type AppRole, declaredSdkAppName, resolvePrimaryAppName } from "../config/schema";

/**
 * The two app lists the SDK host is resolved from. They differ on purpose: a
 * declaration is honored anywhere in the topology, while the guess stays local.
 */
export interface SdkAppScope {
    /** Every app of the merged topology - a dependency repo's app may host the handler. */
    all: readonly AppRole[];
    /** This repo's apps, where the primary-app fallback is resolved. */
    primaryRepo: readonly AppRole[];
}

/**
 * The preview origin of the app hosting the Environment Factory handler - the app
 * a scenario up/down must be sent to.
 *
 * An app that declares `sdk_implemented` wins from anywhere in the merged topology:
 * a front-end repo whose API lives in a connected repo declares the flag on that
 * dependency's app, and the deploy has to honor it. Absent a declaration this falls
 * back to the primary app of THIS repo - the pre-flag behaviour, and the right
 * answer for a full-stack app - never to a dependency's app, which would silently
 * move the endpoint for topologies that never opted in.
 *
 * Undefined when the resolved app has no deployed URL in this environment; the
 * caller then leaves the endpoint to be derived from the preview's primary URL.
 */
export function resolveSdkAppUrl(scope: SdkAppScope, urls: Record<string, string>): string | undefined {
    const declaredAppName = declaredSdkAppName(scope.all);
    if (declaredAppName != null) return urls[declaredAppName];

    const primaryAppName = resolvePrimaryAppName(scope.primaryRepo);
    if (primaryAppName == null) return undefined;
    return urls[primaryAppName];
}
