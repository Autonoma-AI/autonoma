/**
 * Request header carrying the browser's PostHog session id to the API.
 *
 * Shared because it is a contract between two packages that cannot see each
 * other: `apps/ui` sets it on every tRPC request and `apps/api` reads it back to
 * stamp `$session_id` on the events it emits. A drift between the two sides
 * fails silently - the header is simply never read, and server-side events go on
 * looking fine while linking to no session at all.
 *
 * Lowercase because that is how it is compared: `Headers.get` is
 * case-insensitive, but the CORS allow-list is matched literally.
 */
export const POSTHOG_SESSION_HEADER = "x-posthog-session-id";
