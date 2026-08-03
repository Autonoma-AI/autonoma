/** Where the discovery catalog is served. Shared so the route and the advertisement agree. */
export const AI_CATALOG_PATH = "/.well-known/ai-catalog.json";

/**
 * A `Link` header advertising the discovery catalog, so an agent finds it from any response
 * rather than having to already know the well-known path.
 *
 * `ai-catalog` is an extension relation, not one in the IANA registry - there is no
 * registered relation for this yet. An unknown `rel` is ignored by clients that do not
 * understand it, so it costs a header and nothing else.
 */
export function aiCatalogLinkHeader(): string {
    return `<${AI_CATALOG_PATH}>; rel="ai-catalog"; type="application/json"`;
}
