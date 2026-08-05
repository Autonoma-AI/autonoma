import { declaredSdkAppName, resolvePrimaryAppName } from "../schemas/previewkit-config";
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
