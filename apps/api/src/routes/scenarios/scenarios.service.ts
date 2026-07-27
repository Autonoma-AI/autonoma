import { createHash } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import {
    type ScenarioManager,
    applyScenarioRecipeUpdate,
    findRecipeProblems,
    isColdStartMessage,
} from "@autonoma/scenario";
import { type ScenarioRecipe, ScenarioRecipeSchema } from "@autonoma/types";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { DryRunSubject } from "../onboarding/dry-run-subject";
import { Service } from "../service";

/**
 * Replaces the raw SDK error on a dry-run `up` failure whose cause is a cold
 * (scaled-to-zero) preview - the raw text ("SDK returned HTTP 503: Error parsing
 * response: Unexpected token 'S'...") reads like a recipe bug when it just means the
 * app is still starting. dryRun already waited out a bounded warm-up, so if it is
 * STILL cold the environment is unusually slow (or not deployed).
 */
const COLD_START_DRY_RUN_MESSAGE =
    "The app's preview appears to still be starting up (it returned 503 Service Unavailable). Previews scale to zero " +
    "when idle, so this is a cold start, not a recipe problem - we already waited for it to wake. Give it a few more " +
    "seconds and run the dry-run again, or confirm the preview is deployed and healthy.";

/** How a dry run deviates from "just run what is stored". Both absent = the UI button's behavior. */
export interface DryRunOptions {
    /** A candidate recipe to provision INSTEAD of the stored one. Never persisted on its own. */
    recipe?: ScenarioRecipe;
    /** Promote `recipe` to the active version, but only if the whole up/down cycle passes. */
    save?: boolean;
}

export class ScenariosService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly scenarioManager: ScenarioManager,
    ) {
        super();
    }

    async configureWebhook(
        applicationId: string,
        deploymentId: string,
        organizationId: string,
        webhookUrl: string,
        webhookHeaders?: Record<string, string>,
    ) {
        this.logger.info("Configuring webhook", { applicationId, deploymentId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        await this.db.branchDeployment.update({
            where: { id: deploymentId },
            data: { webhookUrl, webhookHeaders: webhookHeaders ?? undefined },
        });

        this.logger.info("Webhook configured", { applicationId, deploymentId });
    }

    async removeWebhook(applicationId: string, deploymentId: string, organizationId: string) {
        this.logger.info("Removing webhook and associated scenarios", { applicationId, deploymentId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        await this.db.$transaction([
            this.db.branchDeployment.update({
                where: { id: deploymentId },
                data: { webhookUrl: null },
            }),
            this.db.scenario.deleteMany({
                where: { applicationId },
            }),
        ]);

        this.logger.info("Webhook removed", { applicationId, deploymentId });
    }

    async discover(applicationId: string, deploymentId: string, organizationId: string) {
        this.logger.info("Discovering scenarios", { applicationId, deploymentId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        await this.scenarioManager.discover(applicationId, deploymentId);

        const scenarios = await this.db.scenario.findMany({
            where: { applicationId },
            orderBy: { name: "asc" },
        });

        this.logger.info("Scenarios discovered", { applicationId, count: scenarios.length });

        return scenarios;
    }

    async listScenarios(applicationId: string, organizationId: string) {
        this.logger.info("Listing scenarios", { applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        return this.db.scenario.findMany({
            where: { applicationId },
            orderBy: { name: "asc" },
        });
    }

    async listInstances(scenarioId: string, organizationId: string) {
        this.logger.info("Listing scenario instances", { scenarioId });

        const scenario = await this.db.scenario.findFirst({
            where: { id: scenarioId, application: { organizationId } },
        });
        if (scenario == null) throw new NotFoundError("Scenario not found");

        return this.db.scenarioInstance.findMany({
            where: { scenarioId },
            orderBy: { requestedAt: "desc" },
        });
    }

    async listWebhookCalls(applicationId: string, organizationId: string) {
        this.logger.info("Listing webhook calls", { applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        return this.db.webhookCall.findMany({
            where: { applicationId },
            orderBy: { createdAt: "desc" },
            take: 50,
        });
    }

    /**
     * Run a scenario end-to-end against the deployed app: `up`, then `down`.
     *
     * With no `recipe`, the scenario's stored active recipe runs - what the UI button does.
     * With one, that CANDIDATE runs instead and is not persisted, so an agent can iterate
     * against the real environment without making a half-finished edit the recipe every
     * future run uses. `save` then promotes the candidate, and only if the whole cycle
     * passed - a recipe that failed can never become the active one through this path.
     */
    async dryRun(applicationId: string, organizationId: string, scenarioId: string, opts?: DryRunOptions) {
        const { recipe, save = false } = opts ?? {};
        this.logger.info("Running scenario dry run", {
            applicationId,
            scenarioId,
            extra: { candidate: recipe != null, save },
        });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        // Scope the scenario to this application before provisioning. ScenarioManager.up
        // enforces the same tenant boundary, so this is defense-in-depth - but doing it
        // here fails a foreign/stale scenarioId early with a typed NotFoundError (surfaced
        // as a clean "unavailable" over MCP) instead of after the deployment lookup.
        const scenario = await this.db.scenario.findFirst({
            where: { id: scenarioId, applicationId },
            select: { id: true, name: true },
        });
        if (scenario == null) throw new NotFoundError("Scenario not found");

        if (recipe != null) {
            // Fail a candidate that cannot resolve here, with the reason, rather than
            // spending a provisioning round trip to be told the same thing less clearly.
            const problems = findRecipeProblems(recipe);
            if (problems.length > 0) {
                this.logger.info("Dry run rejected the candidate recipe", { applicationId, scenarioId });
                return {
                    success: false as const,
                    phase: "recipe" as const,
                    error: { message: `Recipe will not provision:\n${problems.map((p) => `- ${p}`).join("\n")}` },
                    saved: false as const,
                };
            }
            if (recipe.name !== scenario.name) {
                throw new TRPCError({
                    code: "BAD_REQUEST",
                    message: `Recipe name must remain "${scenario.name}"`,
                });
            }
        }

        const subject = new DryRunSubject(this.db, applicationId);
        // Onboarding previews scale to zero, so the first hit often 503s while the pod
        // wakes. Ride through that here so a cold environment is not reported as a
        // broken recipe (the production test-time path can opt in the same way later).
        const instance = await this.scenarioManager.up(subject, scenarioId, {
            coldStartRetry: true,
            candidateRecipe: recipe,
        });

        if (instance.status === "UP_FAILED") {
            const coldStart = instance.lastError != null && isColdStartMessage(instance.lastError.message);
            this.logger.info("Dry run failed during up phase", { applicationId, scenarioId, extra: { coldStart } });
            return {
                success: false as const,
                phase: "up" as const,
                error: coldStart ? { message: COLD_START_DRY_RUN_MESSAGE } : instance.lastError,
                coldStart,
                saved: false as const,
            };
        }

        const downResult = await this.scenarioManager.down(instance.id);

        if (downResult?.status === "DOWN_FAILED") {
            this.logger.info("Dry run failed during down phase", { applicationId, scenarioId });
            return {
                success: false as const,
                phase: "down" as const,
                error: downResult.lastError,
                saved: false as const,
            };
        }

        const saved = recipe != null && save;
        if (saved) {
            await this.updateRecipe(scenarioId, JSON.stringify(recipe), organizationId);
        }

        this.logger.info("Dry run succeeded", { applicationId, scenarioId, extra: { saved } });
        return { success: true as const, phase: "down" as const, error: undefined, saved };
    }

    async getRecipe(scenarioId: string, organizationId: string) {
        this.logger.info("Getting recipe", { scenarioId });

        const scenario = await this.db.scenario.findFirst({
            where: { id: scenarioId, application: { organizationId } },
            select: {
                id: true,
                activeRecipeVersion: {
                    select: {
                        id: true,
                        snapshotId: true,
                        fingerprint: true,
                        fixtureJson: true,
                        updatedAt: true,
                    },
                },
                application: {
                    select: {
                        mainBranch: {
                            select: {
                                activeSnapshotId: true,
                                pendingSnapshotId: true,
                            },
                        },
                    },
                },
            },
        });
        if (scenario == null) throw new NotFoundError("Scenario not found");

        const pendingSnapshotId = scenario.application.mainBranch?.pendingSnapshotId ?? null;
        const pendingRecipeVersion =
            pendingSnapshotId != null
                ? await this.db.scenarioRecipeVersion.findUnique({
                      where: { scenarioId_snapshotId: { scenarioId: scenario.id, snapshotId: pendingSnapshotId } },
                      select: { id: true },
                  })
                : null;

        return {
            fixtureJson: scenario.activeRecipeVersion?.fixtureJson ?? null,
            activeRecipeVersion:
                scenario.activeRecipeVersion != null
                    ? {
                          id: scenario.activeRecipeVersion.id,
                          snapshotId: scenario.activeRecipeVersion.snapshotId,
                          fingerprint: scenario.activeRecipeVersion.fingerprint,
                          updatedAt: scenario.activeRecipeVersion.updatedAt,
                      }
                    : null,
            mainBranch: {
                activeSnapshotId: scenario.application.mainBranch?.activeSnapshotId ?? null,
                pendingSnapshotId,
            },
            pendingRecipeVersionExists: pendingRecipeVersion != null,
        };
    }

    async updateRecipe(scenarioId: string, fixtureJsonString: string, organizationId: string) {
        this.logger.info("Updating recipe", { scenarioId });

        const scenario = await this.db.scenario.findFirst({
            where: { id: scenarioId, application: { organizationId } },
            select: {
                id: true,
                name: true,
                activeRecipeVersionId: true,
                lastSeenFingerprint: true,
                applicationId: true,
                organizationId: true,
                application: {
                    select: {
                        mainBranch: {
                            select: {
                                activeSnapshotId: true,
                                pendingSnapshotId: true,
                            },
                        },
                    },
                },
                activeRecipeVersion: {
                    select: {
                        id: true,
                        snapshotId: true,
                        schemaSnapshot: {
                            select: {
                                structureJson: true,
                                fingerprint: true,
                            },
                        },
                    },
                },
            },
        });
        if (scenario == null) throw new NotFoundError("Scenario not found");
        if (scenario.activeRecipeVersionId == null || scenario.activeRecipeVersion == null) {
            throw new NotFoundError("No active recipe version");
        }
        const activeRecipeVersion = scenario.activeRecipeVersion;

        let parsed: unknown;
        try {
            parsed = JSON.parse(fixtureJsonString);
        } catch {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid JSON syntax" });
        }

        const validation = ScenarioRecipeSchema.safeParse(parsed);
        if (!validation.success) {
            // Prettify to a per-field "path: message" list so the caller (the scenarios
            // UI or the onboarding agent) sees exactly which fields are wrong and can fix
            // them, instead of a raw serialized ZodError.
            throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Invalid recipe:\n${z.prettifyError(validation.error)}`,
            });
        }

        if (validation.data.name !== scenario.name) {
            throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Recipe name must remain "${scenario.name}"`,
            });
        }

        // Everything below only fails at provisioning time, which is minutes and a
        // deploy away - reject here instead, with the reason, so the editor (or the
        // agent) can fix it on the spot.
        const problems = findRecipeProblems(validation.data);
        if (problems.length > 0) {
            throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Recipe will not provision:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
            });
        }

        const fingerprint = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
        const pendingSnapshotId = scenario.application.mainBranch?.pendingSnapshotId;
        const fingerprintChanged = scenario.lastSeenFingerprint !== fingerprint;

        const { updatedRecipeVersions } = await applyScenarioRecipeUpdate(this.db, {
            scenario: {
                id: scenario.id,
                applicationId: scenario.applicationId,
                organizationId: scenario.organizationId,
                activeRecipeVersion,
            },
            recipe: validation.data,
            fingerprint,
            pendingSnapshotId: pendingSnapshotId ?? undefined,
            fingerprintChanged,
        });

        this.logger.info("Recipe updated", { scenarioId, updatedRecipeVersions });
        return { updatedRecipeVersions };
    }
}
