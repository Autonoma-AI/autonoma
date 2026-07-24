/**
 * The one place that knows what a previewkit preview hostname looks like.
 *
 * Before this module the rule was written out seven times - twice as a regex in
 * the API (CORS, trusted origins) and five times as an inline `endsWith` in the UI
 * - so a change to the hostname scheme had to be found in seven places.
 *
 * Two strictness levels exist on purpose, because the callers ask different
 * questions:
 *
 * - {@link isPreviewHostname} asks "am I, the running app, served from a preview?"
 *   That is self-knowledge with no attacker in the loop, so a suffix check is
 *   enough and a false negative just picks the wrong API origin.
 * - {@link isPreviewOrigin} asks "should I trust this origin?" That is a security
 *   decision, so it additionally requires https and the hex label that
 *   `buildAppHostname` actually produces.
 *
 * Keeping the strict one strict is what stops `evil-preview.autonoma.app` and
 * `x.preview.autonoma.app.attacker.com` from being trusted.
 */

/**
 * Hostname label previewkit generates: the first 12 hex characters of an
 * HMAC-SHA256 (`buildAppHostname`, apps/previewkit/src/deployer/resource-factory.ts).
 * Length is left open so a change to that slice does not silently reject the fleet.
 */
const PREVIEW_LABEL_PATTERN = /^[a-f0-9]+$/;

/**
 * Whether a bare hostname sits under the preview domain. The loose check - no
 * scheme, no label shape - matching what the UI has always used to decide whether
 * it is itself running inside a preview environment.
 *
 * Do NOT use this to validate something you are about to trust; use
 * {@link isPreviewOrigin}, which also pins the scheme and the label.
 */
export function isPreviewHostname(hostname: string, internalDomain: string): boolean {
    return hostname.endsWith(`.preview.${internalDomain}`);
}

/**
 * Whether a string is exactly a preview origin - scheme, host, nothing else.
 * This is the security-grade check the API uses to decide whether to hand out CORS
 * headers or treat an origin as trusted, so it rejects anything carrying a path.
 */
export function isPreviewOrigin(candidate: string, internalDomain: string): boolean {
    const url = parseUrl(candidate);
    if (url == null) return false;
    if (url.href.replace(/\/$/, "") !== url.origin) return false;
    if (url.protocol !== "https:") return false;
    if (!isPreviewHostname(url.hostname, internalDomain)) return false;

    // The boundary dot is part of the suffix above, so what remains is the single
    // label in front of it. Requiring it to be the hex digest previewkit generates
    // rejects a lookalike host that merely nests under the preview domain.
    const label = url.hostname.slice(0, -`.preview.${internalDomain}`.length);
    return PREVIEW_LABEL_PATTERN.test(label);
}

function parseUrl(candidate: string): URL | undefined {
    try {
        return new URL(candidate);
    } catch {
        // Not a parseable URL - the caller treats that the same as a disallowed
        // host, so there is nothing to report beyond the rejection itself.
        return undefined;
    }
}
