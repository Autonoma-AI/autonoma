import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Services } from "../routes/build-services";
import { applyReadyConfig } from "./apply-ready-config";
import type { McpAnalytics } from "./mcp-analytics";
import { targetInputFields, toTargetInput } from "./mcp-target-input";
import type { McpTarget, McpTargetInput } from "./resolve-mcp-target";
import { jsonResult, toToolResult } from "./tool-result";

export interface SharedReadToolDeps {
    services: Services;
    analytics: McpAnalytics;
    /** Resolves either identity form to the application the call acts on. */
    resolveTarget: (input: McpTargetInput) => Promise<McpTarget>;
}

/**
 * The read tools both MCP servers offered, registered once.
 *
 * They existed on each server under the same name with the same body, differing only in
 * whether they took `applicationId` or `repoFullName` - so an agent connected to both could
 * not tell which `get_config` it was calling, and the docs' only defence was asking people to
 * name the server literally in their prompt. Each now takes either form.
 *
 * Registered on both servers rather than moved to one, so no existing configuration breaks
 * while the two are being merged.
 */
export function registerSharedReadTools(server: McpServer, { services, analytics, resolveTarget }: SharedReadToolDeps) {
    server.registerTool(
        "get_config",
        {
            title: "Read the full preview config",
            description:
                "Read the FULL preview config document: every app, service (databases, caches, side-containers), " +
                "and hook - no secret values. Read this first when you need to change the SHAPE of the preview " +
                "(add or remove an app or a service), then edit the document and send it back with apply_config. " +
                "For a build/wiring tweak to ONE existing service, edit_previewkit_config is simpler and does not " +
                "need the whole document. `document` is what is STORED, which for an app onboarded before the " +
                "framework presets were retired can carry a build method apply_config no longer accepts. When that " +
                "is the case an `applyReady` block is returned: edit and send `applyReady.document` instead - it is " +
                "the same config with those builds rewritten as the supported equivalent, and `applyReady.guidance` " +
                "says what to tell the user. There is ONE config per application: it is shared by the base " +
                "environment and every pull request, so no PR number is involved here and none can narrow it.",
            inputSchema: targetInputFields,
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async (input) =>
            analytics.track("get_config", async () => {
                try {
                    const { applicationId, organizationId } = await resolveTarget(toTargetInput(input));
                    // The onboarding read, which is a superset of what the debug one returned: it
                    // adds `deployBranch`, and both reach the same underlying config service.
                    const config = await services.onboarding.getPreviewkitConfig(applicationId, organizationId);
                    return jsonResult({
                        document: config.document,
                        configExists: config.saved,
                        deployBranch: config.deployBranch,
                        applyReady: applyReadyConfig(config.document),
                    });
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "list_scenarios",
        {
            title: "List the app's scenarios",
            description:
                "List this application's scenarios - the named test-data states Autonoma provisions before a run - " +
                "and whether each already has a recipe.",
            inputSchema: targetInputFields,
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async (input) =>
            analytics.track("list_scenarios", async () => {
                try {
                    const { applicationId, organizationId } = await resolveTarget(toTargetInput(input));
                    const scenarios = await services.scenarios.listScenarios(applicationId, organizationId);
                    return jsonResult({
                        scenarios: scenarios.map((scenario) => ({
                            id: scenario.id,
                            name: scenario.name,
                            isDisabled: scenario.isDisabled,
                            hasRecipe: scenario.activeRecipeVersionId != null,
                        })),
                    });
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "get_recipe",
        {
            title: "Read a scenario's recipe",
            description:
                "Read one scenario's current recipe - the JSON `create` graph and `variables` your SDK handler " +
                "turns into rows - as `fixtureJson`. Returns a top-level `fingerprint`; ALWAYS pass it to " +
                "update_recipe as `baseFingerprint`, or the write is unconditional and silently overwrites whatever " +
                "another editor saved in the meantime. `liveRecipeVersion` is the version main's active snapshot " +
                "pins, which is what production runs actually seed: when `isLiveRecipeInSync` is false it carries " +
                "its own `fixtureJson` and what you read above is NOT what runs today; when true it is the same " +
                "recipe and is not repeated.",
            inputSchema: { ...targetInputFields, scenarioId: z.string().min(1) },
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async ({ scenarioId, ...input }) =>
            analytics.track("get_recipe", async () => {
                try {
                    const { applicationId, organizationId } = await resolveTarget(toTargetInput(input));
                    return jsonResult(await services.scenarios.getRecipe(applicationId, organizationId, scenarioId));
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "list_dry_run_targets",
        {
            title: "List previews a dry run can target",
            description:
                "The previews a scenario dry run can be pointed at - open PR previews and the base environment - " +
                "with which one Autonoma detected as the SDK implementation PR, and whether each is deployed yet. " +
                "`availability` is read from what each preview's last deploy recorded, never probed, so check " +
                "`freshness`: a `ready` target whose deploy is `stale` may no longer be serving, and a dry run " +
                "against it will fail on an unreachable host rather than on your recipe.",
            inputSchema: targetInputFields,
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        async (input) =>
            analytics.track("list_dry_run_targets", async () => {
                try {
                    const { applicationId, organizationId } = await resolveTarget(toTargetInput(input));
                    return jsonResult(await services.onboarding.listSdkDryRunTargets(applicationId, organizationId));
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );
}
