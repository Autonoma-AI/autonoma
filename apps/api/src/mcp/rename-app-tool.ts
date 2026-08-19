import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Services } from "../routes/build-services";
import type { McpAnalytics } from "./mcp-analytics";
import { targetInputFields, toTargetInput } from "./mcp-target-input";
import type { McpTarget, McpTargetInput } from "./resolve-mcp-target";
import { toToolResult } from "./tool-result";
import type { WriteGuard } from "./write-guard";

export interface RenameAppToolDeps {
    services: Services;
    analytics: McpAnalytics;
    resolveTarget: (input: McpTargetInput) => Promise<McpTarget>;
    guard: WriteGuard;
}

const RENAME_APP_DESCRIPTION =
    "Rename an app in the preview config, keeping everything attached to it.\n\n" +
    "USE THIS RATHER THAN RENAMING IN apply_config. A document says only what the topology should look like " +
    "afterwards, so an app that arrives under a new name is indistinguishable from a new app: the old one is " +
    "deleted, and its stored secrets and build history are deleted with it. That includes the AUTONOMA_SHARED_SECRET " +
    "and AUTONOMA_SIGNING_SECRET the platform provisioned, so the preview comes back up unable to answer a scenario " +
    "call. This tool renames the underlying record instead, so nothing is lost.\n\n" +
    "Call get_config again afterwards before your next apply_config: the document you are holding still has the old " +
    "name in it, and sending it back would delete the app you just renamed.";

/**
 * `rename_app`: the one edit a document cannot express.
 *
 * An app's secrets, deployed instances and build history all hang off its row, and they cascade
 * when it goes. A rename expressed as a document is a delete plus a create, so all three are
 * destroyed - silently, and only noticed later when the preview cannot authenticate. Naming the
 * row instead keeps its id, and everything pointing at it survives.
 */
export function registerRenameAppTool(
    server: McpServer,
    { services, analytics, resolveTarget, guard }: RenameAppToolDeps,
) {
    server.registerTool(
        "rename_app",
        {
            title: "Rename a preview app without losing its secrets",
            description: RENAME_APP_DESCRIPTION,
            inputSchema: {
                ...targetInputFields,
                from: z.string().min(1).describe("The app's current name, as get_config reports it."),
                to: z.string().min(1).describe("The new name. Must be a valid Kubernetes name."),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        async ({ from, to, ...target }) =>
            analytics.track("rename_app", async () => {
                try {
                    const { applicationId, organizationId } = await resolveTarget(toTargetInput(target));

                    return await guard(
                        {
                            applicationId,
                            organizationId,
                            tool: "rename_app",
                            // Same reasoning as apply_config: a preview config only means
                            // something when Autonoma builds the previews.
                            requires: {
                                source: "previewkit",
                                useInstead: "get_signal_setup",
                                useInsteadOnVercel: "get_vercel_setup",
                            },
                            message: `Renaming preview app ${from} to ${to}`,
                            toolArguments: { from, to },
                        },
                        async (org) => {
                            const app = await services.previewkitOperations.findApp(applicationId, org, from);
                            await services.previewkitOperations.apply(applicationId, org, [
                                { op: "renameApp", appId: app.id, name: to },
                            ]);
                            return {
                                renamed: { from, to },
                                note: "Call get_config before your next apply_config - the document you are holding still names the old app.",
                            };
                        },
                    );
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );
}
