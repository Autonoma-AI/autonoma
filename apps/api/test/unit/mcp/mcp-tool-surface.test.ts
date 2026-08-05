import { PostHogAnalytics } from "@autonoma/analytics";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "../../../src/mcp/build-mcp-server";
import { McpAnalytics } from "../../../src/mcp/mcp-analytics";
import type { McpSurface } from "../../../src/mcp/mcp-surface";

/**
 * The tools `/v1/mcp/debug` served before the surfaces were merged. Every one of them must
 * still be there: someone has this address in their MCP configuration, and a tool that
 * disappears from it breaks them silently, mid-session.
 */
const HISTORICAL_DEBUG_TOOLS = [
    "list_apps",
    "get_deploy_status",
    "get_endpoints",
    "get_build_logs",
    "get_app_logs",
    "diagnose_deploy",
    "get_analysis",
    "start_analysis",
    "get_secret_status",
    "set_secret",
    "edit_previewkit_config",
    "wait_for_deploy",
    // Shared with onboarding, registered once.
    "get_config",
    "list_scenarios",
    "get_recipe",
    "list_dry_run_targets",
    "apply_config",
    "update_recipe",
    "dry_run_scenario",
];

/** The tools `/v1/mcp/onboarding` served before the merge, on the same terms. */
const HISTORICAL_ONBOARDING_TOOLS = [
    "pair",
    "get_github_connection",
    "link_repository",
    "select_preview_path",
    "request_env",
    "trigger_deploy",
    "get_session_status",
    "finish_onboarding",
    "get_vercel_setup",
    "link_vercel_project",
    "create_vercel_deployment",
    "get_vercel_deployment_status",
    "select_vercel_deployment",
    "get_signal_setup",
    "get_signal_status",
    "confirm_signal_setup",
    "get_target_logs",
    "validate_sdk",
    // Shared with debug, registered once.
    "get_config",
    "list_scenarios",
    "get_recipe",
    "list_dry_run_targets",
    "apply_config",
    "update_recipe",
    "dry_run_scenario",
];

/**
 * Registering a tool wires a handler; nothing reads the service graph, the database or the
 * principal until a tool is actually called. So the surface can be enumerated against
 * stand-ins, with no containers and no fixtures.
 */
async function toolNamesOn(surface: McpSurface): Promise<string[]> {
    const server = buildMcpServer(surface, {
        services: {},
        db: {},
        principal: { userId: "user-1", organizationIds: ["org-1"] },
        analytics: new McpAnalytics(new PostHogAnalytics(), surface, "user-1"),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
        const { tools } = await client.listTools();
        return tools.map((tool) => tool.name);
    } finally {
        await client.close();
        await server.close();
    }
}

describe("the MCP tool surface", () => {
    it("serves exactly the union of the two historical surfaces on /v1/mcp, with no duplicates", async () => {
        const names = await toolNamesOn("mcp");

        expect(new Set(names).size).toBe(names.length);
        expect([...names].sort()).toEqual(
            [...new Set([...HISTORICAL_DEBUG_TOOLS, ...HISTORICAL_ONBOARDING_TOOLS])].sort(),
        );
    });

    it("serves the same tools on every address, so an alias is never the lesser surface", async () => {
        const [merged, debug, onboarding] = await Promise.all([
            toolNamesOn("mcp"),
            toolNamesOn("debug"),
            toolNamesOn("onboarding"),
        ]);

        expect([...debug].sort()).toEqual([...merged].sort());
        expect([...onboarding].sort()).toEqual([...merged].sort());
    });

    it("keeps every tool the debug address used to serve", async () => {
        const names = new Set(await toolNamesOn("debug"));

        expect(HISTORICAL_DEBUG_TOOLS.filter((tool) => !names.has(tool))).toEqual([]);
    });

    it("keeps every tool the onboarding address used to serve", async () => {
        const names = new Set(await toolNamesOn("onboarding"));

        expect(HISTORICAL_ONBOARDING_TOOLS.filter((tool) => !names.has(tool))).toEqual([]);
    });
});

/**
 * The tools the surface guidance sends an agent to by name. Guidance that names a tool the
 * server does not have is worse than guidance that names none - it reads as authoritative and
 * sends the agent looking for something that was renamed out from under it.
 */
const GUIDANCE_ENTRY_POINTS = ["pair", "get_analysis"];

describe("the connect-time instructions", () => {
    it("only sends an agent to tools that exist", async () => {
        const names = new Set(await toolNamesOn("mcp"));

        expect(GUIDANCE_ENTRY_POINTS.filter((tool) => !names.has(tool))).toEqual([]);
    });

    it("teach both jobs on /v1/mcp and lead with the alias's own job on the old addresses", async () => {
        const instructionsFor = async (surface: McpSurface): Promise<string> => {
            const server = buildMcpServer(surface, {
                services: {},
                db: {},
                principal: { userId: "user-1", organizationIds: ["org-1"] },
                analytics: new McpAnalytics(new PostHogAnalytics(), surface, "user-1"),
            });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            const client = new Client({ name: "test-client", version: "0.0.0" });
            await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
            try {
                return client.getInstructions() ?? "";
            } finally {
                await client.close();
                await server.close();
            }
        };

        const [merged, debug, onboarding] = await Promise.all([
            instructionsFor("mcp"),
            instructionsFor("debug"),
            instructionsFor("onboarding"),
        ]);

        // The merged surface has to route between the two jobs before either playbook applies.
        expect(merged).toContain("pair(code)");
        expect(merged).toContain("get_analysis(repoFullName, prNumber)");

        // Each alias still opens on the job its users came for, and names the other half rather
        // than leaving unexplained tools in the list.
        expect(debug.indexOf("get_analysis")).toBeLessThan(debug.indexOf("also carries"));
        expect(onboarding.indexOf("pair(code)")).toBeLessThan(onboarding.indexOf("also carries"));
    });
});
