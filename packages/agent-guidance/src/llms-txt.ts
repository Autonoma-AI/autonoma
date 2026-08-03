import { aiCatalog } from "./ai-catalog";
import { AI_CATALOG_PATH } from "./link-header";

export interface LlmsTxtInput {
    /** Origin MCP clients dial, and where the discovery catalog is served. */
    apiUrl: string;
    /** UI origin, used for the links a human has to click (creating a key). */
    appUrl: string;
    /** Public docs origin. */
    docsUrl?: string;
}

const DEFAULT_DOCS_URL = "https://docs.autonoma.app";

/**
 * The `llms.txt` for the application host.
 *
 * Without one, this path falls through to the SPA and answers 200 with `text/html` - worse
 * than a 404, because an agent gets a success it may then try to parse as llms.txt. The
 * documentation site generates its own; this one covers the app origin and exists mainly to
 * redirect an agent's attention to the machine surfaces, since almost everything else here
 * is behind a session and not worth scraping.
 *
 * The surface list is rendered from {@link aiCatalog} rather than written out again, so a new
 * MCP server or a renamed endpoint reaches both documents at once. Two hand-maintained lists
 * of the same URLs would disagree the first time one was edited alone, and this file exists
 * to be read by something that cannot notice the discrepancy.
 *
 * Deliberately short. The convention is a pointer file, and a long one competes with the
 * documentation site's generated version rather than complementing it.
 */
export function llmsTxt({ apiUrl, appUrl, docsUrl }: LlmsTxtInput): string {
    const docs = docsUrl ?? DEFAULT_DOCS_URL;
    const api = apiUrl.replace(/\/+$/, "");
    const app = appUrl.replace(/\/+$/, "");
    const surfaces = aiCatalog({ apiUrl, docsUrl })
        .entries.map((entry) => `- [${entry.displayName}](${entry.url}): ${entry.description}`)
        .join("\n");

    return `# Autonoma

> Agentic end-to-end testing. Autonoma deploys a preview environment for a pull request, runs end-to-end tests against it, and reports what broke.

This host serves the Autonoma web application, which is behind a session and not useful to scrape - the public site is https://getautonoma.com. If you are an agent, use the machine-readable surfaces below.

## Agent surfaces

- [Resource catalog](${api}${AI_CATALOG_PATH}): Every surface below as an Agentic Resource Discovery document, in one fetch. Start here.
${surfaces}

## Authentication

Send \`Authorization: Bearer <key>\` with an Autonoma API key. This needs no browser, so it works from CI and from agents running anywhere. Create a key at ${app}/settings/api-keys.

OAuth is also supported for clients that can open a browser on the same machine; an unauthenticated request describes both options in its response body.

## Documentation

- [Documentation](${docs}/llms.txt): Full documentation index, in the same format as this file.
- [MCP guide](${docs}/mcp/): Connecting a coding agent, including headless setups.
- [Preview environments](${docs}/preview-environments/secrets/): Configuring builds, secrets and test data.
`;
}
