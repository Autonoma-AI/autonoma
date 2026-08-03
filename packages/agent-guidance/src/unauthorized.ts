/**
 * Where an agent can go to make progress. Kept as data rather than a prose string so
 * every surface renders the same facts in whatever shape suits it - a JSON body, a
 * terminal hint, an error boundary - without any of them re-writing the wording.
 */
export interface AuthenticationOption {
    /** Stable machine key, so an agent can branch on it rather than parsing prose. */
    method: "oauth" | "api_key";
    /** Who this option is for, in the reader's terms. */
    suitedTo: string;
    /** What to actually do, as one imperative sentence. */
    howTo: string;
}

/** The body returned when a request to an authenticated surface carries no usable credential. */
export interface UnauthorizedGuidance {
    error: "unauthorized";
    /** What this endpoint is. An agent handed a bare URL has no other way to find out. */
    resource: string;
    message: string;
    authenticate: AuthenticationOption[];
    documentation: string;
}

export interface UnauthorizedGuidanceInput {
    /**
     * App origin, used to point at the API-keys screen. Defaults to the canonical public host,
     * so a caller with no environment context still gets a link that works; pass it on
     * per-environment deploys so the caller is sent to their own settings page.
     */
    appUrl?: string;
    /** Docs origin. Defaults to the canonical public host, which is the same in every environment. */
    docsUrl?: string;
    /** Which surface was called, so the body names the thing the caller actually hit. */
    surface: "mcp" | "api";
}

/** Canonical public hosts, used when a caller has no environment-specific origin to pass. */
const DEFAULT_APP_URL = "https://autonoma.app";
const DEFAULT_DOCS_URL = "https://docs.autonoma.app";

const SURFACE_DESCRIPTION: Record<UnauthorizedGuidanceInput["surface"], string> = {
    mcp: "Autonoma MCP server (Streamable HTTP)",
    api: "Autonoma API",
};

/** Where each surface's own documentation lives, so the link lands on the thing the caller called. */
const SURFACE_DOCS_PATH: Record<UnauthorizedGuidanceInput["surface"], string> = {
    mcp: "/mcp/",
    api: "/preview-environments/secrets/",
};

/**
 * The body for a 401.
 *
 * This exists because the previous body was `{"error":"Unauthorized"}` and nothing else. A coding
 * agent pointed at one of our URLs - which is how people actually share Autonoma with their agent -
 * had no way to discover that an API key would work, so it retried the browser OAuth flow it could
 * never complete. The 401 is the one moment we are guaranteed to have the caller's attention, so it
 * is the cheapest place to teach.
 *
 * Deliberately still a 401 with an unchanged `WWW-Authenticate` header: MCP clients discover the
 * authorization server from that challenge, so the status and headers are a contract. Only the body,
 * which was previously wasted, carries the guidance.
 */
export function unauthorizedGuidance({ appUrl, docsUrl, surface }: UnauthorizedGuidanceInput): UnauthorizedGuidance {
    const app = appUrl ?? DEFAULT_APP_URL;
    const docs = docsUrl ?? DEFAULT_DOCS_URL;
    return {
        error: "unauthorized",
        resource: SURFACE_DESCRIPTION[surface],
        message: "This endpoint needs a credential. Either option below works; the API key needs no browser.",
        authenticate: [
            {
                method: "api_key",
                suitedTo: "headless agents, CI, and anything without a browser",
                howTo: `Send the header 'Authorization: Bearer <key>'. Create a key at ${app}/settings/api-keys.`,
            },
            {
                method: "oauth",
                suitedTo: "interactive clients that can open a browser on this machine",
                howTo: "Complete the OAuth flow advertised in the WWW-Authenticate header of this response.",
            },
        ],
        documentation: `${docs}${SURFACE_DOCS_PATH[surface]}`,
    };
}
