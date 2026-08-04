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
    "THE CONFIG IS PER APPLICATION, NOT PER PULL REQUEST. There is exactly one saved document, and every " +
    "environment deploys from it: the base environment and every open pull request, including ones you are not " +
    "working on. Whatever you send here becomes that one document. Per-environment configuration is a known " +
    "limitation and may come later; today there is no way to give one pull request a different config, and nothing " +
    "in this tool scopes a change to one.\n\n" +
    "`prNumber` therefore chooses only WHICH environment is redeployed with the newly saved document (unless " +
    "`apply` is false) - it does not scope the save. Omit it to save without redeploying a pull request; `branch` " +
    "then sets which branch the base preview deploys from. If the user wanted a change that affects only their PR, " +
    "say that is not possible rather than sending it and implying it was.";

/**
 * `apply_config`, registered once for both servers.
 *
 * It previously existed on each under the same name doing materially different things: the
 * debug copy redeployed one PR's environment after saving, the onboarding copy saved and set
 * the deploy branch. An agent got whichever its connection happened to provide.
 *
 * One tool now, with `prNumber` selecting between them. What it does NOT select is what gets
 * written: an Application has a single `PreviewkitConfig` row that every environment deploys
 * from, so both paths save the same document and a PR-scoped preview config is not
 * representable. The tool's description says so outright, because the parameter shape reads
 * like it should scope the write and an agent that believes that would report a local change
 * while having altered main and every other open PR.
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
                    .describe(
                        "Redeploy this pull request's environment with the saved document. It does NOT scope the " +
                            "save: the document is the application's, shared by every environment. Omit it to save " +
                            "without redeploying a pull request.",
                    ),
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

                    // Both branches save the SAME per-application document; a preview config
                    // cannot be scoped to one environment. `prNumber` only picks the redeploy:
                    // this branch redeploys that PR's environment, the other one leaves every
                    // environment on its current deploy and can also set the deploy branch.
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
