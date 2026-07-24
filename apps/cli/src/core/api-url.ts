// Production API host. Every caller resolves the host through resolveApiUrl so the
// default lives in exactly one place: a caller that reads AUTONOMA_API_URL raw gets
// `undefined` outside an explicitly-configured environment and silently skips its
// request instead of talking to production.
const DEFAULT_API_URL = "https://autonoma.app";

/**
 * The Autonoma API host to talk to: the AUTONOMA_API_URL override when set (an
 * alpha/preview host), production otherwise. Never carries a trailing slash, so
 * callers can append `/v1/...` directly.
 */
export function resolveApiUrl(override?: string): string {
    return (override ?? DEFAULT_API_URL).replace(/\/+$/, "");
}
