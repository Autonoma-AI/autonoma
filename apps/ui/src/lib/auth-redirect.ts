/**
 * Where to send someone after they sign in.
 *
 * Before this, every auth bounce dropped the destination on the floor: `/login`
 * accepted only `?error`, and Google sign-in hard-coded `callbackURL` to the app
 * origin. Anyone deep-linked into a gated page had to find their way back by hand
 * after signing in - fine for the app shell, useless for a link out of a GitHub
 * comment that is trying to reach one specific preview.
 */

/** Where a signed-in user lands when there is nothing better to return to. */
const DEFAULT_DESTINATION = "/";

/**
 * Narrows an untrusted `redirectTo` to a same-origin path.
 *
 * This value survives a round trip through an external identity provider and is
 * then handed to the browser, so an unvalidated one is an open redirect: an
 * attacker sends `/login?redirectTo=https://evil.example` and the victim is
 * bounced there wearing a fresh session.
 *
 * A protocol-relative `//evil.example` is the case a naive `startsWith("/")` check
 * misses - the browser reads it as an absolute URL - so a second leading slash is
 * rejected explicitly, as is a backslash, which some parsers fold to `/`.
 */
export function safeRedirectTo(candidate: string | undefined): string {
    if (candidate == null || candidate === "") return DEFAULT_DESTINATION;
    if (!candidate.startsWith("/")) return DEFAULT_DESTINATION;
    if (candidate.startsWith("//") || candidate.startsWith("/\\")) return DEFAULT_DESTINATION;
    return candidate;
}

/**
 * The current location as a `redirectTo` value: path, query and hash, without the
 * origin. Used when a route guard bounces an unauthenticated visitor to `/login`.
 */
export function currentPathForRedirect(location: Location): string {
    return `${location.pathname}${location.search}${location.hash}`;
}

/**
 * Absolute URL for an identity provider's `callbackURL`, which cannot take a bare path.
 *
 * With nothing to return to this yields the bare origin rather than `origin + "/"`,
 * so a sign-in with no `redirectTo` produces byte-identical input to what this
 * codepath sent before the parameter existed. Every sign-in goes through here, and
 * a gratuitous trailing slash on that path buys nothing.
 */
export function absoluteRedirectUrl(origin: string, candidate: string | undefined): string {
    const path = safeRedirectTo(candidate);
    return path === DEFAULT_DESTINATION ? origin : `${origin}${path}`;
}
