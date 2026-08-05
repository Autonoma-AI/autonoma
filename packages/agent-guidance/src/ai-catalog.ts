/**
 * One resource an agent can use. The envelope is deliberately artifact-agnostic: `type` is an
 * IANA media type naming the underlying schema, which ARD does not redefine.
 */
export interface AiCatalogEntry {
    /** Stable identifier. The spec recommends a URN, so a registry can dedupe across crawls. */
    identifier: string;
    displayName: string;
    /** Media type of the resource, e.g. `application/mcp-server+json`. */
    type: string;
    url: string;
    description: string;
}

/** The `/.well-known/ai-catalog.json` document. */
export interface AiCatalog {
    specVersion: string;
    host: {
        displayName: string;
        identifier: string;
    };
    entries: AiCatalogEntry[];
}

export interface AiCatalogInput {
    /** Origin MCP clients actually dial, which in production differs from the UI origin. */
    apiUrl: string;
    /** Public docs origin, used for the entries' human-readable documentation. */
    docsUrl?: string;
    /** The domain that identifies us to a registry. */
    hostIdentifier?: string;
}

const SPEC_VERSION = "1.0";
const DEFAULT_HOST_IDENTIFIER = "autonoma.app";
/** The spec's identifier scheme is `urn:air:` - Agentic Information Resource - not `urn:ai:`. */
const URN_PREFIX = "urn:air";
const DEFAULT_DOCS_URL = "https://docs.autonoma.app";

const MCP_SERVER_MEDIA_TYPE = "application/mcp-server+json";
const OPENAPI_MEDIA_TYPE = "application/openapi+json";

/**
 * The Agentic Resource Discovery catalog: one fetch that tells an agent every surface we
 * offer it, so it does not have to already know our URLs to find them.
 *
 * The motivating case is an agent handed nothing but our domain. Discovery today is entirely
 * word of mouth - someone pastes an MCP URL into a chat - which works only if the person
 * already knows the URL. This is the machine-readable version of that paste.
 *
 * Built rather than checked in as a static file because the URLs are environment-specific:
 * a per-PR alpha deployment must advertise its own endpoints, not production's.
 */
export function aiCatalog({ apiUrl, docsUrl, hostIdentifier }: AiCatalogInput): AiCatalog {
    const docs = docsUrl ?? DEFAULT_DOCS_URL;
    const identifier = hostIdentifier ?? DEFAULT_HOST_IDENTIFIER;
    const api = apiUrl.replace(/\/+$/, "");

    return {
        specVersion: SPEC_VERSION,
        // The spec identifies a host by DID, not by bare domain.
        host: { displayName: "Autonoma", identifier: `did:web:${identifier}` },
        entries: [
            {
                identifier: `${URN_PREFIX}:${identifier}:mcp:all`,
                displayName: "Autonoma MCP",
                type: MCP_SERVER_MEDIA_TYPE,
                url: `${api}/v1/mcp`,
                description:
                    "Every Autonoma tool on one server. Onboard an application: choose how previews are built, apply configuration, trigger a deploy, validate the test-data SDK, and take the app live. Then debug what Autonoma flags on a pull request: analysis findings, preview deploy status, build and runtime logs, secrets, and scenario recipes. Authenticate with an API key or OAuth. " +
                    `Docs: ${docs}/mcp/`,
            },
            // The addresses people already have configured. They serve the same server as
            // `/v1/mcp` and are not going away, but a fresh integration should use the one above,
            // so they are listed as aliases rather than as two separate products.
            {
                identifier: `${URN_PREFIX}:${identifier}:mcp:debug`,
                displayName: "Autonoma MCP (debugging alias)",
                type: MCP_SERVER_MEDIA_TYPE,
                url: `${api}/v1/mcp/debug`,
                description:
                    "Alias for the Autonoma MCP above, kept for existing configurations. Same server and same tools; its connect-time guidance leads with debugging a reviewed pull request. New integrations should use /v1/mcp. " +
                    `Docs: ${docs}/mcp/`,
            },
            {
                identifier: `${URN_PREFIX}:${identifier}:mcp:onboarding`,
                displayName: "Autonoma MCP (onboarding alias)",
                type: MCP_SERVER_MEDIA_TYPE,
                url: `${api}/v1/mcp/onboarding`,
                description:
                    "Alias for the Autonoma MCP above, kept for existing configurations. Same server and same tools; its connect-time guidance leads with onboarding a new application. New integrations should use /v1/mcp. " +
                    `Docs: ${docs}/mcp/configure-preview/`,
            },
            {
                identifier: `${URN_PREFIX}:${identifier}:api:previewkit`,
                displayName: "Autonoma preview environments API",
                type: OPENAPI_MEDIA_TYPE,
                url: `${api}/v1/previewkit/openapi.json`,
                description:
                    "REST API for preview environments: environment status, secrets, deploy and teardown. Authenticate with an API key.",
            },
        ],
    };
}
