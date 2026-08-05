import type { PrismaClient } from "@autonoma/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Services } from "../routes/build-services";
import { registerApplyConfigTool } from "./apply-config-tool";
import { registerDebugTools } from "./debug-tools";
import { listAccessibleRepos } from "./list-accessible-repos";
import type { McpAnalytics } from "./mcp-analytics";
import type { McpPrincipal } from "./mcp-principal";
import { type McpSurface, surfaceGuidance } from "./mcp-surface";
import { registerOnboardingTools } from "./onboarding-tools";
import { registerReadTools } from "./read-tools";
import { registerRecipeTools } from "./recipe-tools";
import { type McpTargetInput, resolveMcpTarget } from "./resolve-mcp-target";
import { resolveRepoContext } from "./resolve-repo-context";
import { createWriteGuard } from "./write-guard";

/** Reported to the client on connect, alongside the surface's name. */
const SERVER_VERSION = "0.1.0";

/** The per-request wiring every surface is built from. */
export interface BuildMcpServerDeps {
    services: Services;
    db: PrismaClient;
    /** The authenticated caller and the complete set of orgs it may act in. */
    principal: McpPrincipal;
    /** Records a `mcp.tool_called` PostHog event per tool invocation, attributed to the surface and the org. */
    analytics: McpAnalytics;
}

/**
 * Builds the MCP server one request is served by: one tool set, registered here, and every
 * address serves all of it - so a client on one of the older addresses is never offered less
 * than a client on /v1/mcp. What the surface picks is the guidance read on connect and the name
 * the calls are attributed to.
 *
 * The registration functions below are groupings, not surfaces: `registerDebugTools` and
 * `registerOnboardingTools` hold the tools only one job uses, and the other three hold the ones
 * both jobs reach for. The write guard is built once and handed to every write, so whether a
 * write serializes with a human is decided by the application it touches and not by where it
 * was declared.
 */
export function buildMcpServer(surface: McpSurface, deps: BuildMcpServerDeps): McpServer {
    const { services, db, principal, analytics } = deps;
    const guidance = surfaceGuidance(surface);
    const server = new McpServer(
        { name: guidance.name, version: SERVER_VERSION },
        { instructions: guidance.instructions },
    );

    const repoReader = { db, listRepositories: (orgId: string) => services.github.listRepositories(orgId) };
    // The org is discovered deep inside a handler (from the repoFullName a tool names), so this
    // records it onto the call's observability context for the analytics event to read back.
    const observedRepoContext = analytics.observeRepoContextResolution((repoFullName: string) =>
        resolveRepoContext(repoReader, principal, repoFullName),
    );
    const guard = createWriteGuard(services);

    registerDebugTools(server, {
        services,
        resolveRepoContext: observedRepoContext,
        listRepos: () => listAccessibleRepos(services.github, principal),
        analytics,
        userId: principal.userId,
        mergeGate: services.mergeGate,
    });

    registerOnboardingTools(server, { services, db, principal, analytics, guard });

    const resolveTarget = (input: McpTargetInput) => resolveMcpTarget(repoReader, principal, input);

    registerReadTools(server, { services, analytics, resolveTarget });
    registerApplyConfigTool(server, { services, analytics, resolveTarget, guard });
    registerRecipeTools(server, { services, analytics, resolveTarget, guard, userId: principal.userId });

    return server;
}
