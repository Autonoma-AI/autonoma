import { unauthorizedGuidance } from "@autonoma/agent-guidance";
import { analytics } from "@autonoma/analytics";
import { verifyApiKey } from "@autonoma/auth";
import { db, type PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Context, Hono } from "hono";
import { auth, createServiceContext } from "../context";
import { env } from "../env";
import type { Services } from "../routes/build-services";
import { buildDebugMcpServer } from "./debug-mcp-server";
import { listAccessibleRepos } from "./list-accessible-repos";
import { McpAnalytics } from "./mcp-analytics";
import { type McpCredential, type McpPrincipal, resolveMcpPrincipal } from "./mcp-principal";
import { buildOnboardingMcpServer } from "./onboarding-mcp-server";
import { resolveMcpTarget } from "./resolve-mcp-target";
import { resolveRepoContext } from "./resolve-repo-context";

const logger = rootLogger.child({ name: "mcpHttpRouter" });

/**
 * What the MCP auth middleware sets on the Hono context. Routes type their env with
 * `Hono<{ Variables: McpAuthVariables }>` so `c.var.mcpAuth` is inferred, matching
 * `UserAuthVariables` / `CallerAuthVariables` in `@autonoma/auth`.
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

/** The per-request wiring a named MCP server is built from. */
interface McpServerDeps {
    services: Services;
    db: PrismaClient;
}

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
 * Client bug resolution: resolves org per `repoFullName` a tool names (the token
 * is userId-only, multi-org) and offers repo discovery for when the agent can't
 * infer the remote from the git config. Every tool call is tracked as an
 * `mcp.tool_called` event, attributed to the org the tool resolves.
 */
mcpHttpRouter.all("/debug", (c) => {
    const { principal } = c.get("mcpAuth");
    // The org is discovered deep inside a handler (from the repoFullName a tool
    // names), so observeRepoContextResolution records it onto the request's
    // observability context for the analytics event to read back. Resolution reads
    // the org's GitHub App installation repos, so it needs the per-request
    // `services.github` (a diffs-only repo has no preview env to shortcut it).
    const mcpAnalytics = new McpAnalytics(analytics, "debug", principal.userId);
    return serveMcp(c, ({ services, db }) => {
        const resolveRepoCtx = mcpAnalytics.observeRepoContextResolution((repoFullName) =>
            resolveRepoContext(
                { db, listRepositories: (orgId) => services.github.listRepositories(orgId) },
                principal,
                repoFullName,
            ),
        );
        return buildDebugMcpServer({
            services,
            resolveRepoContext: resolveRepoCtx,
            resolveTarget: (input) =>
                resolveMcpTarget(
                    { db, listRepositories: (orgId) => services.github.listRepositories(orgId) },
                    principal,
                    input,
                ),
            listRepos: () => listAccessibleRepos(services.github, principal),
            analytics: mcpAnalytics,
            userId: principal.userId,
            mergeGate: services.mergeGate,
        });
    });
});

/**
 * PreviewKit onboarding: pins its app via a pairing code the user copies from the
 * UI and resolves org per call from the pinned applicationId. Every tool call is
 * tracked as an `mcp.tool_called` event, attributed to the resolved org.
 */
mcpHttpRouter.all("/onboarding", (c) => {
    const { principal } = c.get("mcpAuth");
    const mcpAnalytics = new McpAnalytics(analytics, "onboarding", principal.userId);
    return serveMcp(c, ({ services, db }) =>
        buildOnboardingMcpServer({ services, db, principal, analytics: mcpAnalytics }),
    );
});

/**
 * The per-request plumbing shared by every server route: log the call, borrow the
 * fully-wired service graph the tRPC layer builds, build the named server, and pump it
 * over Streamable HTTP.
 *
 * Deliberately `createServiceContext` and not `createContext`: the caller was already
 * authenticated in middleware, and the tools read identity from the principal, never from
 * the context. `createContext` would re-run a session lookup and a second `verifyApiKey`
 * (an unindexed scan of `api_key`) plus a user fetch, and then we would throw all of it away.
 */
async function serveMcp(c: Context<McpEnv>, build: (deps: McpServerDeps) => McpServer) {
    const { principal, credential } = c.get("mcpAuth");
    logger.info("Handling MCP request", {
        userId: principal.userId,
        extra: { path: c.req.path, credential, organizationCount: principal.organizationIds.length },
    });

    const { services, db } = createServiceContext();
    const server = build({ services, db });
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);

    // No request-level observability scope: each tool call opens its own inside
    // McpAnalytics.track, so org attribution doesn't depend on this async context
    // surviving the transport dispatch.
    const response = await transport.handleRequest(c);
    return response ?? c.body(null, 204);
}
