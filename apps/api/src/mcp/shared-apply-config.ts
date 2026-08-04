import type { OnboardingPreviewEnvironmentMode } from "@autonoma/db";
import { type AgentLogEntry, authoringPreviewConfigSchema } from "@autonoma/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Services } from "../routes/build-services";
import type { McpAnalytics } from "./mcp-analytics";
import { targetInputFields, toTargetInput } from "./mcp-target-input";
import type { McpTarget, McpTargetInput } from "./resolve-mcp-target";
import { jsonResult, toToolResult } from "./tool-result";

/**
 * Runs a write, having whatever protection the mounting server applies.
 *
 * The onboarding server holds a soft mutex so a human on the config screen and an agent do
 * not both write at once; the debug server has none, because nobody is watching a form for a
 * long-live application. Passing that in keeps the difference where it belongs - a property of
 * the application's situation - instead of encoding it in which file a tool was declared in.
 */
export type WriteGuard = <T>(
    params: {
        applicationId: string;
        /** Already resolved by the caller, so a guard never has to look it up again. */
        organizationId: string;
        tool: string;
        message: string;
        /** Rendered on the activity row where a guard shows one; never carries secret values. */
        toolArguments?: AgentLogEntry["toolArguments"];
        /**
         * Refuse the write when the application gets its previews the other way, naming the
         * tool to use instead. Passed through rather than left to the mount: it is a property
         * of the tool (config only means something for previews Autonoma builds), not of the
         * server the tool happens to be reached through.
         */
        requires?: {
            source: OnboardingPreviewEnvironmentMode;
            useInstead: string;
            useInsteadOnVercel?: string;
        };
    },
    work: (organizationId: string) => Promise<T>,
) => Promise<CallToolResult>;

export interface SharedApplyConfigDeps {
    services: Services;
    analytics: McpAnalytics;
    resolveTarget: (input: McpTargetInput) => Promise<McpTarget>;
    guard: WriteGuard;
}

const APPLY_CONFIG_DESCRIPTION =
    "Save the FULL preview config document - the path for structural changes a single-app patch cannot express: " +
    "adding or removing an app, or a service (a database, cache, or side-container). Read the current document with " +
    "get_config first, edit it, and send the whole thing back.\n\n" +
    "Omit prNumber to save the application's BASE config, which is what onboarding and any later change to the " +
    "app's shape want; `branch` sets which branch that base preview deploys from. Pass prNumber to apply the " +
    "document to ONE pull request's environment instead, which redeploys it unless `apply` is false.";

/**
 * `apply_config`, registered once for both servers.
 *
 * It previously existed on each under the same name doing materially different things: the
 * debug copy applied a document to one PR's environment, the onboarding copy saved the base
 * config and set its deploy branch. An agent got whichever its connection happened to provide.
 *
 * One tool now, with `prNumber` selecting between them - matching the convention elsewhere in
 * the codebase, where a missing PR number means the main/base environment.
 */
export function registerSharedApplyConfig(
    server: McpServer,
    { services, analytics, resolveTarget, guard }: SharedApplyConfigDeps,
) {
    server.registerTool(
        "apply_config",
        {
            title: "Save the full preview config",
            description: APPLY_CONFIG_DESCRIPTION,
            inputSchema: {
                ...targetInputFields,
                document: authoringPreviewConfigSchema,
                prNumber: z
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .describe("Apply to this pull request's environment. Omit to save the application's base config."),
                branch: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        "Branch the base preview deploys from. Omit to use the repo's default branch; set it when " +
                            "the user is working on a different branch (ask them which to use). Ignored with prNumber.",
                    ),
                apply: z
                    .boolean()
                    .optional()
                    .describe("With prNumber: redeploy the environment after saving. Defaults to true."),
                description: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("One line on what you changed - the user watches it on the activity feed."),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        async ({ document, prNumber, branch, apply, description, ...target }) =>
            analytics.track("apply_config", async () => {
                try {
                    const { applicationId, organizationId } = await resolveTarget(toTargetInput(target));

                    // A PR's environment is a live deploy target, not the application's saved shape,
                    // so it never touches the base config or the deploy branch.
                    if (prNumber != null) {
                        const repoFullName = "repoFullName" in target ? target.repoFullName : undefined;
                        if (repoFullName == null) {
                            return toToolResult(
                                new Error(
                                    "Applying to a pull request needs repoFullName, since the environment is keyed by repo and PR.",
                                ),
                            );
                        }
                        const result = await services.previewkitWrite.applyConfig({
                            applicationId,
                            repoFullName,
                            prNumber,
                            document,
                            apply: apply ?? true,
                            organizationId,
                        });
                        return jsonResult(result);
                    }

                    return guard(
                        {
                            applicationId,
                            organizationId,
                            tool: "apply_config",
                            // Saving a config only means anything when Autonoma builds the
                            // previews; on the customer's own pipeline there is nothing to
                            // configure, so refuse and point at the tool that does apply.
                            requires: {
                                source: "previewkit",
                                useInstead: "get_signal_setup",
                                useInsteadOnVercel: "get_vercel_setup",
                            },
                            message: description ?? "Saving preview config",
                            toolArguments:
                                branch != null
                                    ? { apps: document.apps.length, branch }
                                    : { apps: document.apps.length },
                        },
                        async (org) => {
                            const saved = await services.onboarding.savePreviewkitConfig(applicationId, org, document);
                            if (branch == null) return saved;
                            const { branch: deployBranch } = await services.onboarding.setDeployBranch(
                                applicationId,
                                org,
                                branch,
                            );
                            return { ...saved, deployBranch };
                        },
                    );
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );
}
