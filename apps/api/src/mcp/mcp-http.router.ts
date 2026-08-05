import { unauthorizedGuidance } from "@autonoma/agent-guidance";
import { analytics } from "@autonoma/analytics";
import { verifyApiKey } from "@autonoma/auth";
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { StreamableHTTPTransport } from "@hono/mcp";
import { type Context, Hono } from "hono";
import { auth, createServiceContext } from "../context";
import { env } from "../env";
import { buildMcpServer } from "./build-mcp-server";
import { McpAnalytics } from "./mcp-analytics";
import { type McpCredential, type McpPrincipal, resolveMcpPrincipal } from "./mcp-principal";
import type { McpSurface } from "./mcp-surface";

const logger = rootLogger.child({ name: "mcpHttpRouter" });

/**
 * What the MCP auth middleware sets on the Hono context. Routes type their env with
 * `Hono<{ Variables: McpAuthVariables }>` so `c.var.mcpAuth` is inferred, matching
 * `UserAuthVariables` in `@autonoma/auth`.
 *
 * The credential is already resolved to its authorization boundary here: routes and tools
 * take the principal, never a bare user id, so the breadth of the credential cannot be lost
 * on the way down.
 */
export interface McpAuthVariables {
    mcpAuth: {
        principal: McpPrincipal;
        /** Which credential authenticated the request, so logs and analytics can tell them apart. */
        credential: "oauth" | "api_key";
    };
}
type McpEnv = { Variables: McpAuthVariables };

/**
 * Resource server for the MCP surface, mounted at `/v1/mcp`. Better Auth is the
 * OAuth authorization server (via the `mcp()` plugin); the auth middleware
 * verifies the bearer access token per request with `auth.api.getMcpSession`
 * (JWT, locally verified - no introspection round-trip) and stashes the session,
 * then each address gets its own route. Every request is stateless: a fresh
 * server + transport, org-scoped to the caller.
 */
export const mcpHttpRouter = new Hono<McpEnv>();

/**
 * Authenticate the bearer once for every server route. On an unauthenticated request it
 * returns 401 with a `WWW-Authenticate` header pointing at the protected-resource metadata,
 * so the client can discover the authorization server, plus a body explaining both ways in -
 * a client that cannot open a browser gets no help at all from the OAuth challenge alone.
 */
mcpHttpRouter.use("*", async (c, next) => {
    const credential = await verifyMcpCredential(c);
    if (credential == null) {
        // Build the challenge URL from the canonical origin (APP_URL), not
        // `c.req.url`: behind the TLS-terminating ingress the request URL is http,
        // which would advertise an insecure metadata URL an OAuth client rejects.
        const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource", env.APP_URL).toString();
        c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
        return c.json(unauthorizedGuidance({ appUrl: env.APP_URL, surface: "mcp" }), 401);
    }
    // Turn the credential into its authorization boundary here, once, so no route or tool
    // ever sees the raw credential and has to remember to narrow by it.
    const principal = await resolveMcpPrincipal(db, credential);
    c.set("mcpAuth", { principal, credential: credential.organizationId != null ? "api_key" : "oauth" });
    return next();
});

/**
 * MCP's OAuth flow is unreachable without a browser: the client picks its own
 * redirect URI and every one of them (Claude Code, `mcp-remote`) listens on
 * localhost, so an agent running on a remote box or in CI has nothing to answer
 * the callback with and the code expires. The API key already authenticates the
 * whole tRPC surface and `/v1/previewkit/*`, so accept it here too rather than
 * leaving headless agents with no way in at all.
 */
async function verifyMcpCredential(c: Context<McpEnv>): Promise<McpCredential | undefined> {
    const session = await auth.api.getMcpSession({ headers: c.req.raw.headers });
    if (session != null) return { userId: session.userId };

    const keyContext = await verifyApiKey(db, c.req.header("authorization"));
    if (keyContext == null) return undefined;
    return { userId: keyContext.userId, organizationId: keyContext.organizationId };
}

/**
 * The address to give out: one server carrying every Autonoma MCP tool - onboarding a new
 * application and debugging a reviewed pull request alike - so a client configures Autonoma once
 * rather than picking a surface before it knows which job it is doing.
 */
mcpHttpRouter.all("/", (c) => serveMcp(c, "mcp"));

/**
 * The debugging address, kept forever for the configurations that already point at it. It serves
 * the same server as `/v1/mcp`; only the connect-time guidance leads with debugging, and calls
 * stay attributed to the `debug` surface so usage on the old address remains distinguishable.
 */
mcpHttpRouter.all("/debug", (c) => serveMcp(c, "debug"));

/** The onboarding address, kept for the same reason and on the same terms. */
mcpHttpRouter.all("/onboarding", (c) => serveMcp(c, "onboarding"));

/**
 * The per-request plumbing shared by every address: log the call, borrow the
 * fully-wired service graph the tRPC layer builds, build the server for this surface, and pump it
 * over Streamable HTTP.
 *
 * Deliberately `createServiceContext` and not `createContext`: the caller was already
 * authenticated in middleware, and the tools read identity from the principal, never from
 * the context. `createContext` would re-run a session lookup and a second `verifyApiKey`
 * (an unindexed scan of `api_key`) plus a user fetch, and then we would throw all of it away.
 */
async function serveMcp(c: Context<McpEnv>, surface: McpSurface) {
    const { principal, credential } = c.get("mcpAuth");
    logger.info("Handling MCP request", {
        userId: principal.userId,
        extra: { path: c.req.path, surface, credential, organizationCount: principal.organizationIds.length },
    });

    const { services, db } = createServiceContext();
    const server = buildMcpServer(surface, {
        services,
        db,
        principal,
        analytics: new McpAnalytics(analytics, surface, principal.userId),
    });
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);

    // No request-level observability scope: each tool call opens its own inside
    // McpAnalytics.track, so org attribution doesn't depend on this async context
    // surviving the transport dispatch.
    const response = await transport.handleRequest(c);
    return response ?? c.body(null, 204);
}
