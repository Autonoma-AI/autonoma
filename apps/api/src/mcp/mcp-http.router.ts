import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { auth, createContext } from "../context";
import { env } from "../env";
import { buildDebugMcpServer } from "./debug-mcp-server";
import { listAccessibleRepos } from "./list-accessible-repos";
import { resolveOrgForRepo } from "./resolve-org-for-repo";

const logger = rootLogger.child({ name: "mcpHttpRouter" });

/**
 * The named MCP servers exposed under `/v1/mcp/<name>`. Namespaced from the start
 * so future MCPs (e.g. an onboarding-specific one) get their own path + tool set
 * instead of overloading one server. Only "debug" (client bug resolution -
 * previewkit tools) exists today.
 */
const KNOWN_SERVERS = new Set(["debug"]);

/**
 * Resource server for the MCP surface, mounted at `/v1/mcp`. Better Auth is the
 * OAuth authorization server (via the `mcp()` plugin); this route verifies the
 * bearer access token per request with `auth.api.getMcpSession` (JWT, locally
 * verified - no introspection round-trip), resolves the user's organization,
 * then dispatches to the named MCP server's tools over Streamable HTTP.
 * Stateless: a fresh server + transport per request, org-scoped to the caller.
 * On an unauthenticated request it returns 401 with a `WWW-Authenticate` header
 * pointing at the protected-resource metadata, so the client can discover the AS.
 */
export const mcpHttpRouter = new Hono();

mcpHttpRouter.all("/:server", async (c) => {
    const serverName = c.req.param("server");
    if (!KNOWN_SERVERS.has(serverName)) {
        return c.json({ error: `Unknown MCP server '${serverName}'` }, 404);
    }

    const session = await auth.api.getMcpSession({ headers: c.req.raw.headers });
    if (session == null) {
        // Build the challenge URL from the canonical origin (APP_URL), not
        // `c.req.url`: behind the TLS-terminating ingress the request URL is http,
        // which would advertise an insecure metadata URL an OAuth client rejects.
        const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource", env.APP_URL).toString();
        c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
        return c.json({ error: "Unauthorized" }, 401);
    }

    logger.info("Handling MCP request", { userId: session.userId, extra: { serverName } });

    // The org is NOT fixed up front: the token carries only a userId, and a user
    // can be in many orgs. Each tool resolves its org from the `repoFullName` it
    // names (which maps to exactly one owning org) and verifies membership - so
    // the MCP handshake (initialize / tools/list) needs no org, and multi-org
    // users work without disambiguation.
    const resolveOrg = (repoFullName: string) => resolveOrgForRepo(db, session.userId, repoFullName);
    // Discovery: the repos this user can debug (across their orgs), so the agent
    // can pick one when it can't infer repoFullName from the working directory.
    const listRepos = () => listAccessibleRepos(db, session.userId);

    // Reuse the same fully-wired service graph the tRPC layer builds. We only
    // borrow its `services`; auth came from the verified MCP token above.
    const { services } = await createContext(c);
    const server = buildDebugMcpServer({ services, resolveOrg, listRepos });
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);

    const response = await transport.handleRequest(c);
    return response ?? c.body(null, 204);
});
