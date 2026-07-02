import { createHash } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { type ScenarioManager, applyScenarioRecipeUpdate } from "@autonoma/scenario";
import { ScenarioRecipeSchema } from "@autonoma/types";
import { TRPCError } from "@trpc/server";
import { DryRunSubject } from "../onboarding/dry-run-subject";
import { Service } from "../service";

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

    async dryRun(applicationId: string, organizationId: string, scenarioId: string) {
        this.logger.info("Running scenario dry run", { applicationId, scenarioId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const subject = new DryRunSubject(this.db, applicationId);
        const instance = await this.scenarioManager.up(subject, scenarioId);

        if (instance.status === "UP_FAILED") {
            this.logger.info("Dry run failed during up phase", { applicationId, scenarioId });
            return { success: false as const, phase: "up" as const, error: instance.lastError };
        }

        const downResult = await this.scenarioManager.down(instance.id);

        if (downResult?.status === "DOWN_FAILED") {
            this.logger.info("Dry run failed during down phase", { applicationId, scenarioId });
            return { success: false as const, phase: "down" as const, error: downResult.lastError };
        }

        this.logger.info("Dry run succeeded", { applicationId, scenarioId });
        return { success: true as const, phase: "down" as const, error: undefined };
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
            throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Invalid recipe: ${validation.error.message}`,
            });
        }

        if (validation.data.name !== scenario.name) {
            throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Recipe name must remain "${scenario.name}"`,
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
