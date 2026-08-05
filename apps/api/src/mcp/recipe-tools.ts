import { ScenarioRecipeSchema } from "@autonoma/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Services } from "../routes/build-services";
import { dryRunOptions } from "./dry-run-options";
import type { McpAnalytics } from "./mcp-analytics";
import { targetInputFields, toTargetInput } from "./mcp-target-input";
import { baseFingerprintInput } from "./recipe-conflict-result";
import { resolveDryRunTargetUrl } from "./resolve-dry-run-target";
import type { McpTarget, McpTargetInput } from "./resolve-mcp-target";
import { toToolResult } from "./tool-result";
import type { WriteGuard } from "./write-guard";

export interface RecipeToolDeps {
    services: Services;
    analytics: McpAnalytics;
    resolveTarget: (input: McpTargetInput) => Promise<McpTarget>;
    guard: WriteGuard;
    /** Recorded as the actor on a recipe write, and on the dry run that validates it. */
    userId: string;
}

/** The activity-row line for a dry run, when the agent did not write one. */
function describeDryRun(hasCandidate: boolean, save: boolean): string {
    if (!hasCandidate) return "Dry-running the stored recipe";
    return save ? "Dry-running a candidate recipe, saving it if it passes" : "Dry-running a candidate recipe";
}

/**
 * The two scenario-recipe writes. Both take either identity and both record an actor - a
 * recipe write is attributable whether it came from onboarding or from an editor months later.
 */
export function registerRecipeTools(
    server: McpServer,
    { services, analytics, resolveTarget, guard, userId }: RecipeToolDeps,
) {
    server.registerTool(
        "update_recipe",
        {
            title: "Save a scenario's recipe",
            description:
                "Save a corrected recipe as the scenario's active version - the recipe name must stay the " +
                "scenario's name. Pass the `fingerprint` from get_recipe as `baseFingerprint` so a write that races " +
                "another editor is rejected instead of overwriting them. Iterate with dry_run_scenario until it passes.",
            inputSchema: {
                ...targetInputFields,
                scenarioId: z.string().min(1),
                recipe: ScenarioRecipeSchema,
                baseFingerprint: baseFingerprintInput,
                description: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("One line on what you changed - the user watches it on the activity feed."),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        async ({ scenarioId, recipe, baseFingerprint, description, ...target }) =>
            analytics.track("update_recipe", async () => {
                try {
                    const { applicationId, organizationId } = await resolveTarget(toTargetInput(target));
                    return guard(
                        {
                            applicationId,
                            organizationId,
                            tool: "update_recipe",
                            message: description ?? `Updating recipe for scenario "${recipe.name}"`,
                            toolArguments: { scenarioId, scenario: recipe.name },
                        },
                        (org) =>
                            services.scenarios.updateRecipe({
                                applicationId,
                                organizationId: org,
                                scenarioId,
                                fixtureJson: JSON.stringify(recipe),
                                source: "MCP",
                                actorUserId: userId,
                                baseFingerprint,
                            }),
                    );
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );

    server.registerTool(
        "dry_run_scenario",
        {
            title: "Dry-run a scenario recipe",
            description:
                "Run a recipe end to end against the deployed app (SDK `up` then `down`); on failure it reports " +
                "which phase failed and the SDK's error. Pass a `recipe` to try an edit WITHOUT storing it, and " +
                "`save: true` to promote one that passes. Pass a `target` from list_dry_run_targets to run against a " +
                "specific preview instead of the app's configured endpoint.",
            inputSchema: {
                ...targetInputFields,
                scenarioId: z.string().min(1),
                recipe: ScenarioRecipeSchema.optional().describe(
                    "A candidate recipe to run INSTEAD of the stored one. Not saved unless `save` is true.",
                ),
                save: z
                    .boolean()
                    .optional()
                    .describe(
                        "Make `recipe` the active recipe, but only if this run passes. Ignored without `recipe`.",
                    ),
                target: z
                    .string()
                    .optional()
                    .describe(
                        "A target `id` from list_dry_run_targets - the preview to provision against. Omit to use " +
                            "the app's currently configured SDK endpoint.",
                    ),
                description: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("One line on what you are trying - the user watches it on the activity feed."),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        async ({ scenarioId, recipe, save = false, target, description, ...targetInput }) =>
            analytics.track("dry_run_scenario", async () => {
                try {
                    const { applicationId, organizationId } = await resolveTarget(toTargetInput(targetInput));
                    return guard(
                        {
                            applicationId,
                            organizationId,
                            tool: "dry_run_scenario",
                            message: description ?? describeDryRun(recipe != null, save),
                            toolArguments: { scenarioId, candidate: recipe != null, save, target: target ?? null },
                        },
                        async (org) =>
                            services.scenarios.dryRun(
                                applicationId,
                                org,
                                scenarioId,
                                dryRunOptions(recipe, save, userId),
                                await resolveDryRunTargetUrl(services, applicationId, org, target),
                            ),
                    );
                } catch (err) {
                    return toToolResult(err);
                }
            }),
    );
}
