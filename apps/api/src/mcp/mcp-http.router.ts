import { analytics } from "@autonoma/analytics";
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Context, Hono } from "hono";
import { auth, createContext } from "../context";
import { env } from "../env";
import type { Services } from "../routes/build-services";
import { buildDebugMcpServer } from "./debug-mcp-server";
import { listAccessibleRepos } from "./list-accessible-repos";
import { McpAnalytics } from "./mcp-analytics";
import { buildOnboardingMcpServer } from "./onboarding-mcp-server";
import { resolveOrgForRepo } from "./resolve-org-for-repo";

const logger = rootLogger.child({ name: "mcpHttpRouter" });

/** The verified MCP bearer session (userId-only, multi-org), stashed by the auth middleware. */
type McpSession = NonNullable<Awaited<ReturnType<typeof auth.api.getMcpSession>>>;
type McpEnv = { Variables: { mcpSession: McpSession } };

/**
 * Resource server for the MCP surface, mounted at `/v1/mcp`. Better Auth is the
 * OAuth authorization server (via the `mcp()` plugin); the auth middleware
 * verifies the bearer access token per request with `auth.api.getMcpSession`
 * (JWT, locally verified - no introspection round-trip) and stashes the session,
 * then each named server gets its own route. Every request is stateless: a fresh
 * server + transport, org-scoped to the caller.
 */
export const mcpHttpRouter = new Hono<McpEnv>();

/**
 * Verify the MCP bearer token once for every server route. On an unauthenticated
 * request it returns 401 with a `WWW-Authenticate` header pointing at the
 * protected-resource metadata, so the client can discover the authorization server.
 */
mcpHttpRouter.use("*", async (c, next) => {
    const session = await auth.api.getMcpSession({ headers: c.req.raw.headers });
    if (session == null) {
        // Build the challenge URL from the canonical origin (APP_URL), not
        // `c.req.url`: behind the TLS-terminating ingress the request URL is http,
        // which would advertise an insecure metadata URL an OAuth client rejects.
        const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource", env.APP_URL).toString();
        c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
        return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("mcpSession", session);
    return next();
});

/**
 * Client bug resolution: resolves org per `repoFullName` a tool names (the token
 * is userId-only, multi-org) and offers repo discovery for when the agent can't
 * infer the remote from the git config. Every tool call is tracked as an
 * `mcp.tool_called` event, attributed to the org the tool resolves.
 */
mcpHttpRouter.all("/debug", (c) => {
    const { userId } = c.get("mcpSession");
    // The org is discovered deep inside a handler (from the repoFullName a tool
    // names), so observeOrgResolution records it onto the request's observability
    // context for the analytics event to read back.
    const mcpAnalytics = new McpAnalytics(analytics, "debug", userId);
    const resolveOrg = mcpAnalytics.observeOrgResolution((repoFullName) => resolveOrgForRepo(db, userId, repoFullName));
    return serveMcp(c, (services) =>
        buildDebugMcpServer({
            services,
            resolveOrg,
            listRepos: () => listAccessibleRepos(db, userId),
            analytics: mcpAnalytics,
        }),
    );
});

/**
 * PreviewKit onboarding: pins its app via a pairing code the user copies from the
 * UI and resolves org per call from the pinned applicationId. Every tool call is
 * tracked as an `mcp.tool_called` event, attributed to the resolved org.
 */
mcpHttpRouter.all("/onboarding", (c) => {
    const { userId } = c.get("mcpSession");
    const mcpAnalytics = new McpAnalytics(analytics, "onboarding", userId);
    return serveMcp(c, (services) => buildOnboardingMcpServer({ services, userId, analytics: mcpAnalytics }));
});

/**
 * The per-request plumbing shared by every server route: log the call, borrow the
 * fully-wired service graph the tRPC layer builds (auth already came from the
 * verified MCP token), build the named server, and pump it over Streamable HTTP.
 */
async function serveMcp(c: Context<McpEnv>, build: (services: Services) => McpServer) {
    const { userId } = c.get("mcpSession");
    logger.info("Handling MCP request", { userId, extra: { path: c.req.path } });

    const { services } = await createContext(c);
    const server = build(services);
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);

    // No request-level observability scope: each tool call opens its own inside
    // McpAnalytics.track, so org attribution doesn't depend on this async context
    // surviving the transport dispatch.
    const response = await transport.handleRequest(c);
    return response ?? c.body(null, 204);
}
