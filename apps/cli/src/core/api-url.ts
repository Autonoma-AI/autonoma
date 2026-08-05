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

/**
 * Where a coding agent connects its Autonoma MCP server.
 *
 * On production this is NOT the host the CLI's own calls go to. `autonoma.app`
 * sits behind CloudFront, whose WAF and buffering interfere with the MCP's
 * streaming HTTP and can mangle a large request body; `api.autonoma.app` is
 * direct to the ALB. The web app resolves the same split in `getApiOrigin()`,
 * and the API advertises the `api.` origin as its OAuth protected resource, so
 * a strict client's resource check only passes against that host.
 *
 * Applied to the production host ALONE. Any `AUTONOMA_API_URL` override already
 * points at an API directly - an alpha host, a per-PR preview, localhost - and
 * prefixing those would invent a hostname that does not resolve.
 */
export function resolveMcpUrl(apiUrl: string): string {
    const base = apiUrl.replace(/\/+$/, "");
    if (base !== DEFAULT_API_URL) return `${base}/v1/mcp`;
    return `https://api.${new URL(DEFAULT_API_URL).hostname}/v1/mcp`;
}
