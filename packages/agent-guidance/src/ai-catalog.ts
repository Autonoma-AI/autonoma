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
        host: { displayName: "Autonoma", identifier },
        entries: [
            {
                identifier: `urn:ai:${identifier}:mcp:debug`,
                displayName: "Autonoma debugging MCP",
                type: MCP_SERVER_MEDIA_TYPE,
                url: `${api}/v1/mcp/debug`,
                description:
                    "Read why Autonoma flagged a pull request and fix it: analysis findings, preview deploy status, build and runtime logs, secrets, and scenario recipes. Authenticate with an API key or OAuth. " +
                    `Docs: ${docs}/mcp/`,
            },
            {
                identifier: `urn:ai:${identifier}:mcp:onboarding`,
                displayName: "Autonoma onboarding MCP",
                type: MCP_SERVER_MEDIA_TYPE,
                url: `${api}/v1/mcp/onboarding`,
                description:
                    "Configure a new application's preview environment: choose how previews are built, apply configuration, trigger a deploy, and validate the test-data SDK. Authenticate with an API key or OAuth. " +
                    `Docs: ${docs}/mcp/configure-preview/`,
            },
            {
                identifier: `urn:ai:${identifier}:api:previewkit`,
                displayName: "Autonoma preview environments API",
                type: OPENAPI_MEDIA_TYPE,
                url: `${api}/v1/previewkit/openapi.json`,
                description:
                    "REST API for preview environments: environment status, secrets, deploy and teardown. Authenticate with an API key.",
            },
        ],
    };
}
