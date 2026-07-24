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
 * - {@link isPreviewOrigin} and {@link isPreviewUrl} ask "should I trust / send a
 *   browser to this?" Those are security decisions, so they additionally require
 *   https and the hex label that `buildAppHostname` actually produces.
 *
 * Keeping the strict pair strict is what stops `evil-preview.autonoma.app` and
 * `x.preview.autonoma.app.attacker.com` from passing.
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
 * Do NOT use this to validate a URL you are about to trust or navigate to; use
 * {@link isPreviewUrl}, which also pins the scheme and the label.
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
    return isTrustedPreviewUrl(url, internalDomain);
}

/**
 * Whether a URL points at a preview and is safe to send a browser to. Same
 * strictness as {@link isPreviewOrigin} but a path, query and fragment are allowed,
 * because a link can point deep into the app (a per-bug "Open preview" href goes
 * straight to the failing screen).
 */
export function isPreviewUrl(candidate: string, internalDomain: string): boolean {
    const url = parseUrl(candidate);
    if (url == null) return false;
    return isTrustedPreviewUrl(url, internalDomain);
}

/**
 * The origin of a preview URL, which is the form `PreviewkitAppInstance.url` is
 * stored in. Anything looking an environment up by URL must normalize first, or a
 * valid deep link resolves to nothing.
 *
 * Returns undefined for input that is not a parseable URL; callers should have
 * validated with {@link isPreviewUrl} first.
 */
export function previewOrigin(candidate: string): string | undefined {
    return parseUrl(candidate)?.origin;
}

function isTrustedPreviewUrl(url: URL, internalDomain: string): boolean {
    if (url.protocol !== "https:") return false;
    // Previews are only ever served on 443, so a non-default port is not one of
    // ours. `url.port` is "" for both an absent port and an explicit :443, which
    // the parser normalizes away - so this rejects :8443 while still accepting the
    // redundant-but-identical :443 spelling.
    if (url.port !== "") return false;
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
        // Parse-or-default, not swallowed error handling: `new URL` throwing IS the
        // answer to "is this a URL", and every caller turns undefined into a plain
        // rejection. Deliberately not logged - the strings reaching here are
        // unauthenticated, attacker-controlled `to` values, so a log line per parse
        // failure would be a free log-spam vector for no diagnostic value.
        return undefined;
    }
}
