import { randomUUID } from "node:crypto";
import type { PrismaClient, ScenarioInstance } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import { fx } from "@autonoma/try";
import type { DiscoverResponse, ScenarioRecipesFile } from "@autonoma/types";
import type { EncryptionHelper } from "./encryption";
import { ScenarioRecipeStore } from "./scenario-recipe-store";
import type { ScenarioApplicationData, ScenarioSubject } from "./scenario-subject";
import { WebhookClient } from "./webhook-client";
import type { WebhookCallOptions } from "./webhook-client";

export interface DiscoverWithConfigParams {
    applicationId: string;
    webhookUrl: string;
    signingSecret: string;
    webhookHeaders?: Record<string, string>;
    options?: WebhookCallOptions;
}

const DEFAULT_EXPIRES_IN_SECONDS = 2 * 60 * 60; // 2 hours

export class ScenarioManager {
    private readonly logger: Logger;
    private readonly recipeStore: ScenarioRecipeStore;

    constructor(
        private readonly db: PrismaClient,
        private readonly encryption: EncryptionHelper,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
        this.recipeStore = new ScenarioRecipeStore(db);
    }

    async discover(
        applicationId: string,
        deploymentId: string,
        options?: WebhookCallOptions,
    ): Promise<DiscoverResponse> {
        const applicationData = await this.getApplicationDataForDeployment(applicationId, deploymentId);
        const webhookClient = this.createWebhookClient(applicationData);

        this.logger.info("Calling discover webhook", { applicationId });
        const response = await webhookClient.discover(options);

        this.logger.info("Discover completed", {
            applicationId,
            modelCount: response.schema.models.length,
        });
        return response;
    }

    /**
     * Call the discover webhook using caller-supplied config, without reading
     * or writing any application/deployment state. Used during onboarding to
     * validate a webhook URL + secret *before* persisting them, so a failed
     * discover can't leave the DB half-configured.
     */
    async discoverWithConfig(params: DiscoverWithConfigParams): Promise<DiscoverResponse> {
        const { applicationId, webhookUrl, signingSecret, webhookHeaders, options } = params;
        const webhookClient = new WebhookClient(
            this.db,
            applicationId,
            webhookUrl,
            signingSecret,
            webhookHeaders ?? {},
        );

        this.logger.info("Calling discover webhook with caller-supplied config", { applicationId });
        const response = await webhookClient.discover(options);
        this.logger.info("Discover (with config) completed", {
            applicationId,
            modelCount: response.schema.models.length,
        });
        return response;
    }

    /**
     * Persist scenario rows from a validated recipe file (same shape as `autonoma/scenario-recipes.json`).
     * Call this only from setup upload paths (`POST .../scenario-recipe-versions`).
     * Does not call the customer webhook.
     */
    async ingestScenarioRecipes(
        snapshotId: string,
        applicationId: string,
        recipesFile: ScenarioRecipesFile,
    ): Promise<{ scenarioCount: number; scenarios: Array<{ id: string; name: string; recipeVersionId: string }> }> {
        this.logger.info("Ingesting scenario recipes", { applicationId, scenarioCount: recipesFile.recipes.length });

        const application = await this.db.application.findUnique({
            where: { id: applicationId },
            select: { id: true, organizationId: true },
        });
        if (application == null) {
            throw new Error(`Application ${applicationId} not found`);
        }

        const result = await this.recipeStore.replaceScenarioRecipes({
            snapshotId,
            applicationId,
            organizationId: application.organizationId,
            recipesFile,
        });

        this.logger.info("Scenario recipes ingested", {
            applicationId,
            scenarioCount: recipesFile.recipes.length,
        });
        return result;
    }

    /**
     * Set up a scenario environment by calling the customer webhook.
     *
     * When `snapshotId` is provided, the recipe version pinned to that snapshot is used.
     * When `snapshotId` is omitted (dry run), the scenario's active recipe version is used.
     */
    async up(
        subject: ScenarioSubject,
        scenarioId: string,
        opts?: { snapshotId?: string; webhookOptions?: WebhookCallOptions },
    ): Promise<ScenarioInstance> {
        const { snapshotId, webhookOptions: options } = opts ?? {};
        const applicationData = await subject.getApplicationData();
        const { applicationId, organizationId } = applicationData;
        const webhookClient = this.createWebhookClient(applicationData);

        const scenario = await this.db.scenario.findUnique({
            where: { id: scenarioId },
            select: { id: true, name: true },
        });
        if (scenario == null) {
            throw new Error(`Scenario "${scenarioId}" not found`);
        }
        const instanceId = randomUUID();

        const recipeResult =
            snapshotId != null
                ? await this.recipeStore.loadRecipeCreatePayloadForSnapshot({
                      scenarioId: scenario.id,
                      snapshotId,
                      testRunId: instanceId,
                  })
                : await this.recipeStore.loadActiveRecipeCreatePayload({
                      scenarioId: scenario.id,
                      testRunId: instanceId,
                  });
        if (recipeResult == null) {
            throw new Error(
                `Scenario "${scenario.name}" does not have a stored recipe version${snapshotId != null ? ` for snapshot ${snapshotId}` : ""}. Complete the Scenario Validation step so the plugin uploads scenario recipes to Autonoma.`,
            );
        }
        const { createPayload, resolvedVariables } = recipeResult;

        const expiresAt = new Date(Date.now() + DEFAULT_EXPIRES_IN_SECONDS * 1000);
        const instance = await this.db.scenarioInstance.create({
            data: {
                id: instanceId,
                applicationId,
                organizationId,
                deploymentId: applicationData.deploymentId,
                scenarioId: scenario.id,
                status: "REQUESTED",
                expiresAt,
            },
        });

        await subject.linkInstance(instance.id);

        this.logger.info("Calling up webhook", { applicationId, scenarioName: scenario.name, instanceId: instance.id });

        const [response, error] = await fx.runAsync(() =>
            webhookClient.up({ instanceId: instance.id, create: createPayload as Record<string, unknown[]> }, options),
        );

        if (error != null) {
            this.logger.error("Scenario up failed", { error: error.message, instanceId: instance.id });
            return this.db.scenarioInstance.update({
                where: { id: instance.id },
                data: {
                    status: "UP_FAILED",
                    lastError: { message: error.message },
                    completedAt: new Date(),
                },
            });
        }

        const expiresInSeconds = response.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
        const updatedExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);

        this.logger.info("Scenario up succeeded", { instanceId: instance.id });
        const hasResolvedVariables = Object.keys(resolvedVariables).length > 0;
        return this.db.scenarioInstance.update({
            where: { id: instance.id },
            data: {
                status: "UP_SUCCESS",
                upAt: new Date(),
                expiresAt: updatedExpiresAt,
                auth: response.auth,
                refs: response.refs,
                refsToken: response.refsToken,
                metadata: response.metadata,
                ...(hasResolvedVariables ? { resolvedVariables } : {}),
            },
        });
    }

    async down(scenarioInstanceId: string, options?: WebhookCallOptions): Promise<ScenarioInstance | undefined> {
        const instance = await this.db.scenarioInstance.findUnique({
            where: { id: scenarioInstanceId },
        });

        if (instance == null) {
            this.logger.info("Scenario instance not found, skipping", { scenarioInstanceId });
            return undefined;
        }

        if (instance.status === "DOWN_SUCCESS" || instance.status === "DOWN_FAILED") {
            this.logger.info("Scenario already torn down, skipping", {
                instanceId: instance.id,
                status: instance.status,
            });
            return instance;
        }

        if (instance.deploymentId == null) {
            throw new Error(`Scenario instance ${scenarioInstanceId} does not have a deployment`);
        }

        const applicationData = await this.getApplicationDataForDeployment(
            instance.applicationId,
            instance.deploymentId,
        );
        const webhookClient = this.createWebhookClient(applicationData);

        this.logger.info("Calling down webhook", { scenarioInstanceId, instanceId: instance.id });

        const [, error] = await fx.runAsync(() =>
            webhookClient.down(
                {
                    instanceId: instance.id,
                    refs: (instance.refs as Record<string, unknown>) ?? null,
                    refsToken: instance.refsToken ?? undefined,
                },
                options,
            ),
        );

        if (error != null) {
            this.logger.error("Scenario down failed", { error: error.message, instanceId: instance.id });
            return this.db.scenarioInstance.update({
                where: { id: instance.id },
                data: {
                    status: "DOWN_FAILED",
                    downAt: new Date(),
                    completedAt: new Date(),
                    lastError: { message: error.message },
                },
            });
        }

        this.logger.info("Scenario down succeeded", { instanceId: instance.id });
        return this.db.scenarioInstance.update({
            where: { id: instance.id },
            data: {
                status: "DOWN_SUCCESS",
                downAt: new Date(),
                completedAt: new Date(),
            },
        });
    }

    private async getApplicationDataForDeployment(
        applicationId: string,
        deploymentId: string,
    ): Promise<ScenarioApplicationData> {
        const application = await this.db.application.findUnique({
            where: { id: applicationId },
            select: { id: true, signingSecretEnc: true, organizationId: true, disabled: true },
        });

        if (application == null) {
            throw new Error(`Application ${applicationId} not found`);
        }
        if (application.disabled) {
            throw new Error(`Application ${applicationId} is disabled`);
        }
        if (application.signingSecretEnc == null) {
            throw new Error(`Application ${applicationId} does not have a signing secret configured`);
        }

        const deployment = await this.db.branchDeployment.findUnique({
            where: { id: deploymentId },
            select: { id: true, webhookUrl: true, webhookHeaders: true },
        });

        if (deployment == null) {
            throw new Error(`Deployment ${deploymentId} not found`);
        }
        if (deployment.webhookUrl == null) {
            throw new Error(`Deployment ${deploymentId} does not have a webhook URL configured`);
        }

        return {
            applicationId: application.id,
            deploymentId: deployment.id,
            organizationId: application.organizationId,
            webhookUrl: deployment.webhookUrl,
            signingSecretEnc: application.signingSecretEnc,
            webhookHeaders: (deployment.webhookHeaders as Record<string, string> | undefined) ?? undefined,
        };
    }

    private createWebhookClient(applicationData: ScenarioApplicationData): WebhookClient {
        const signingSecret = this.encryption.decrypt(applicationData.signingSecretEnc);
        return new WebhookClient(
            this.db,
            applicationData.applicationId,
            applicationData.webhookUrl,
            signingSecret,
            applicationData.webhookHeaders,
        );
    }
}
