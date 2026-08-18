import { parseUrl } from "./parse-url";
/**
 * The one place that knows how an Environment Factory endpoint URL is spelled:
 * the preview origin of the app hosting the handler, plus the path it is mounted
 * at. Which app that is comes from the config (`resolveSdkAppName`); this module
 * owns only the URL arithmetic, so it stays dependency-free and both the API and
 * the scenario package can reach it.
 *
 * The path is a convention, not a law - the SDK can be mounted anywhere, and an
 * app that deviates declares it with the app's `sdk_path`. Hence the split
 * between the two functions here, which answer different questions:
 *
 * - {@link buildSdkUrl} composes an endpoint from an origin, defaulting the path.
 *   Callers that have an origin and nothing else use this.
 * - {@link applySdkPath} re-points an endpoint that ALREADY exists at a declared
 *   path. It is a no-op when nothing is declared, which is what keeps a URL a
 *   customer registered by hand from being rewritten to the convention.
 * - {@link reResolveSdkEndpoint} re-points a stored endpoint at the app the
 *   config now declares as the SDK host when that is a DIFFERENT app than it was
 *   stored against, and otherwise degrades to {@link applySdkPath}.
 */

/**
 * Where the SDK handler sits unless an app says otherwise. Every generated
 * integration and every doc example mounts it here, so it is the right guess for
 * an app that never declared a path.
 */
export const DEFAULT_SDK_PATH = "/api/autonoma";

/**
 * The Environment Factory endpoint on a preview origin. `path` comes from the
 * SDK app's `sdk_path` when it declares one; absent, the convention applies.
 */
export function buildSdkUrl(previewUrl: string, path?: string | null): string {
    const mountPath = path != null && path !== "" ? path : DEFAULT_SDK_PATH;
    return `${previewUrl.replace(/\/$/, "")}${mountPath}`;
}

/**
 * Re-point an existing endpoint URL at a declared path, keeping its origin.
 *
 * Returns the input untouched when no path is given, and that is the whole
 * point: "no declared path" must mean "leave this URL alone", never "assume the
 * convention". Some endpoints were registered by hand during onboarding at a
 * path of the customer's choosing, and defaulting here would silently rewrite
 * them to `/api/autonoma` and 404 every provision.
 *
 * An unparseable input is returned as-is rather than thrown on: the caller's
 * next step is an HTTP call that will fail with a far better message than a URL
 * parse error raised three layers below it.
 */
export function applySdkPath(sdkUrl: string, path: string | null | undefined): string {
    if (path == null || path === "") return sdkUrl;

    const url = parseUrl(sdkUrl);
    if (url == null) return sdkUrl;

    // The query survives the swap: `sdk_path` cannot carry one (the schema's
    // regex rejects `?`), so a query on the stored URL is something else - a
    // token a hand-registered endpoint needs to authenticate - and dropping it
    // would turn a working endpoint into a 401.
    return `${url.origin}${path}${url.search}`;
}

/**
 * Re-resolve a stored SDK endpoint against the app the config now declares as the SDK host.
 *
 * `applySdkPath` keeps the stored origin and only swaps the path - right while the same app hosts
 * the handler, but wrong for an endpoint first stored via the primary-app fallback: when
 * `sdk_implemented` moves, the stored origin is now an app with no handler and every provision 404s.
 *
 * `declaredSdkAppUrl` is the URL of the app that EXPLICITLY set `sdk_implemented` (undefined when
 * none does); only an explicit declaration can overrule a stored endpoint, never a primary-app guess.
 * The owning app is judged by ORIGIN - the endpoint carries no other trace of which app produced it.
 * Same origin preserves the stored path (a hand-registered path survives); a differing origin
 * re-points the host wholesale, taking the declared path (else the convention).
 */
export function reResolveSdkEndpoint({
    storedEndpoint,
    declaredSdkAppUrl,
    declaredPath,
}: {
    storedEndpoint: string | undefined;
    declaredSdkAppUrl: string | undefined;
    declaredPath: string | null | undefined;
}): string | undefined {
    if (storedEndpoint == null || storedEndpoint === "") return undefined;

    // No explicit SDK host declared: the stored endpoint stands, path corrected. `applySdkPath` behavior.
    if (declaredSdkAppUrl == null || declaredSdkAppUrl === "") {
        return applySdkPath(storedEndpoint, declaredPath);
    }

    // Declared host unparseable: keep the stored endpoint rather than compose a broken URL.
    const declaredOrigin = parseUrl(declaredSdkAppUrl)?.origin;
    if (declaredOrigin == null) return applySdkPath(storedEndpoint, declaredPath);

    // Same app still owns it: preserve the stored path. Owning app changed: re-point the whole host.
    const storedOrigin = parseUrl(storedEndpoint)?.origin;
    if (storedOrigin === declaredOrigin) return applySdkPath(storedEndpoint, declaredPath);
    return buildSdkUrl(declaredOrigin, declaredPath);
}

/**
 * The mount path of an endpoint URL - the inverse of {@link buildSdkUrl}, for recording the path that a call
 * actually reached. Undefined when the input is not a URL.
 *
 * Never carries a query: a stored URL's query is a credential belonging to that endpoint, not part of where the
 * handler is mounted, and `sdk_path` cannot hold one anyway.
 */
export function sdkPathOf(sdkUrl: string): string | undefined {
    return parseUrl(sdkUrl)?.pathname;
}
