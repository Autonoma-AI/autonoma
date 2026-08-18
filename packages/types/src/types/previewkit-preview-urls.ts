import { declaredSdkAppName, declaredSdkPath, resolvePrimaryAppName } from "../schemas/previewkit-config";
import { reResolveSdkEndpoint } from "../sdk-endpoint";
import type { PreviewkitManifest } from "./previewkit-manifest";

/**
 * Undefined when the primary app has no URL - deliberately NOT a sibling's. Substituting another origin points the
 * browsing agents at the wrong application, which is worse than reporting no preview.
 */
export function resolvePrimaryUrl(manifest: PreviewkitManifest, urls: Record<string, string>): string | undefined {
    const primaryAppName = resolvePrimaryAppName(manifest.apps ?? []);
    if (primaryAppName == null) return undefined;
    return urls[primaryAppName];
}

/** Explicit declarations only, so a caller can tell one from the primary-app fallback {@link resolveSdkAppUrl} folds in. */
export function resolveDeclaredSdkAppUrl(
    manifest: PreviewkitManifest,
    urls: Record<string, string>,
): string | undefined {
    const declaredAppName = declaredSdkAppName(manifest.apps ?? []);
    const declaredAppUrl = declaredAppName != null ? urls[declaredAppName] : undefined;
    return declaredAppUrl != null && declaredAppUrl !== "" ? declaredAppUrl : undefined;
}

/**
 * Callers append `/api/autonoma` themselves. Scope is the MERGED topology - the environment persists one resolved
 * config, so which repo contributed an app is not recoverable, and the fallback can land on a dependency (#2062).
 */
export function resolveSdkAppUrl(manifest: PreviewkitManifest, urls: Record<string, string>): string | undefined {
    const declaredAppName = declaredSdkAppName(manifest.apps ?? []);
    if (declaredAppName != null) return urls[declaredAppName];
    return resolvePrimaryUrl(manifest, urls);
}

/**
 * The path the SDK host mounts the handler at, as this environment's config declares it. Undefined means the config
 * has no opinion, NOT that it is at the convention: a caller composing an endpoint then applies the default
 * (`buildSdkUrl`), and one holding a stored endpoint leaves its path alone (`applySdkPath`).
 */
export function resolveSdkPath(manifest: PreviewkitManifest): string | undefined {
    return declaredSdkPath(manifest.apps ?? []);
}

/**
 * A preview's already-stored SDK endpoint, re-resolved against this environment's config and app URLs.
 *
 * Handles the sticky case: a stored endpoint first registered via the primary-app fallback keeps that
 * host even after `sdk_implemented` moves. {@link reResolveSdkEndpoint} overrules the stored host only
 * when an app EXPLICITLY declares itself the SDK host and its origin differs; otherwise the endpoint is
 * left alone (path corrected), preserving a hand-registered origin/path. Undefined when there is no
 * stored endpoint to re-resolve.
 */
export function resolveSdkEndpointUrl(
    manifest: PreviewkitManifest,
    urls: Record<string, string>,
    storedEndpoint: string | undefined,
): string | undefined {
    return reResolveSdkEndpoint({
        storedEndpoint,
        declaredSdkAppUrl: resolveDeclaredSdkAppUrl(manifest, urls),
        declaredPath: resolveSdkPath(manifest),
    });
}
