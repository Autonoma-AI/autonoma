import type { PrismaClient, ScenarioInstance } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import { fx } from "@autonoma/try";
import type { EncryptionHelper } from "./encryption";
import type { ScenarioApplicationData, ScenarioSubject } from "./scenario-subject";
import { WebhookClient } from "./webhook-client";
import type { WebhookCallOptions } from "./webhook-client";

const DEFAULT_EXPIRES_IN_SECONDS = 2 * 60 * 60; // 2 hours

export class ScenarioManager {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly encryption: EncryptionHelper,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async discover(applicationId: string, deploymentId: string, options?: WebhookCallOptions): Promise<void> {
        const applicationData = await this.getApplicationDataForDeployment(applicationId, deploymentId);
        const webhookClient = this.createWebhookClient(applicationData);

        this.logger.info("Calling discover webhook", { applicationId });
        const response = await webhookClient.discover(options);

        await Promise.all(
            response.environments.map(async (scenario) => {
                const existing = await this.db.scenario.findUnique({
                    where: { applicationId_name: { applicationId, name: scenario.name } },
                });

                const fingerprintChanged =
                    scenario.fingerprint != null &&
                    existing?.lastSeenFingerprint != null &&
                    scenario.fingerprint !== existing.lastSeenFingerprint;

                await this.db.scenario.upsert({
                    where: { applicationId_name: { applicationId, name: scenario.name } },
                    create: {
                        applicationId,
                        name: scenario.name,
                        description: scenario.description,
                        lastSeenFingerprint: scenario.fingerprint,
                        lastDiscoveredAt: new Date(),
                        fingerprintChangedAt: scenario.fingerprint != null ? new Date() : undefined,
                        organizationId: applicationData.organizationId,
                    },
                    update: {
                        description: scenario.description,
                        lastSeenFingerprint: scenario.fingerprint,
                        lastDiscoveredAt: new Date(),
                        ...(fingerprintChanged ? { fingerprintChangedAt: new Date() } : {}),
                    },
                });
            }),
        );

        this.logger.info("Discover completed", { applicationId, scenarioCount: response.environments.length });
    }

    async up(subject: ScenarioSubject, scenarioId: string, options?: WebhookCallOptions): Promise<ScenarioInstance> {
        const applicationData = await subject.getApplicationData();
        const { applicationId, organizationId } = applicationData;
        const webhookClient = this.createWebhookClient(applicationData);

        const scenario = await this.db.scenario.findUnique({
            where: { id: scenarioId },
        });
        if (scenario == null) {
            throw new Error(`Scenario "${scenarioId}" not found`);
        }

        const expiresAt = new Date(Date.now() + DEFAULT_EXPIRES_IN_SECONDS * 1000);
        const instance = await this.db.scenarioInstance.create({
            data: {
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
            webhookClient.up({ instanceId: instance.id, scenarioName: scenario.name }, options),
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
                    refs: instance.refs,
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
