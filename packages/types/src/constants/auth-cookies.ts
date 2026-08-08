/**
 * Cookie recording which social provider last completed a sign-in.
 *
 * Shared because it is a contract between two packages that cannot see each other:
 * `apps/api` sets it in the auth hook after a successful OAuth callback, and the
 * `apps/ui` login page reads it back to promote and badge that provider. A drift
 * between the two sides fails silently - the cookie is simply never read, and every
 * returning visitor sees an unordered set of buttons as if they had never signed in.
 *
 * Deliberately not httpOnly, since the login page reads it in the browser. That is
 * safe: it holds a provider id and nothing else.
 */
export const LAST_SOCIAL_PROVIDER_COOKIE = "autonoma.last_social_provider";
