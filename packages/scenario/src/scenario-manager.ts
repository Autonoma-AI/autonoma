import { randomUUID } from "node:crypto";
import type { PrismaClient, ScenarioInstance } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import type { DiscoverResponse, ScenarioVariableScalar, UpResponse } from "@autonoma/types";
import { DbSdkCallRecorder } from "./db-sdk-call-recorder";
import type { EncryptionHelper } from "./encryption";
import { ScenarioRecipeStore } from "./scenario-recipe-store";
import type { ScenarioSubject } from "./scenario-subject";
import { SdkClient, type SdkCallOptions } from "./sdk-client";

const DEFAULT_EXPIRES_IN_SECONDS = 2 * 60 * 60; // 2 hours

interface ScenarioApplicationData {
    applicationId: string;
    deploymentId: string;
    organizationId: string;
    sdkUrl: string;
    signingSecretEnc: string;
    sdkHeaders?: Record<string, string>;
}

export class ScenarioManager {
    private readonly logger: Logger;
    private readonly recipeStore: ScenarioRecipeStore;
    private readonly recorder: DbSdkCallRecorder;

    constructor(
        private readonly db: PrismaClient,
        private readonly encryption: EncryptionHelper,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
        this.recipeStore = new ScenarioRecipeStore(db);
        this.recorder = new DbSdkCallRecorder(db);
    }

    async discover(applicationId: string, deploymentId: string, options?: SdkCallOptions): Promise<DiscoverResponse> {
        const applicationData = await this.getApplicationDataForDeployment(applicationId, deploymentId);
        const sdkClient = this.createSdkClient(applicationData);

        this.logger.info("Calling discover on SDK endpoint", { applicationId });
        const response = await sdkClient.discover(options);

        this.logger.info("Discover completed", {
            applicationId,
            modelCount: response.schema.models.length,
        });
        return response;
    }

    /**
     * Set up a scenario environment by calling the SDK endpoint.
     *
     * When `snapshotId` is provided, the recipe version pinned to that snapshot is used.
     * When `snapshotId` is omitted (dry run), the scenario's active recipe version is used.
     */
    async up(
        subject: ScenarioSubject,
        scenarioId: string,
        opts?: { snapshotId?: string; sdkOptions?: SdkCallOptions },
    ): Promise<ScenarioInstance> {
        const { snapshotId, sdkOptions } = opts ?? {};
        const { applicationId, deploymentId } = await subject.resolveDeployment();
        const applicationData = await this.getApplicationDataForDeployment(applicationId, deploymentId);
        const { organizationId } = applicationData;
        const sdkClient = this.createSdkClient(applicationData);

        const scenario = await this.db.scenario.findUnique({
            where: { id: scenarioId },
            select: { id: true, name: true },
        });
        if (scenario == null) {
            throw new Error(`Scenario "${scenarioId}" not found`);
        }
        const instanceId = randomUUID();

        const recipeResult = await this.recipeStore.loadRecipePayload({
            scenarioId: scenario.id,
            snapshotId,
            testRunId: instanceId,
        });
        if (recipeResult == null) {
            throw new Error(
                `Scenario "${scenario.name}" does not have a stored recipe version${snapshotId != null ? ` for snapshot ${snapshotId}` : ""}. Complete the Scenario Validation step so the plugin uploads scenario recipes to Autonoma.`,
            );
        }
        const { createPayload, resolvedVariables } = recipeResult;

        const instance = await this.db.scenarioInstance.create({
            data: {
                id: instanceId,
                applicationId,
                organizationId,
                deploymentId: applicationData.deploymentId,
                scenarioId: scenario.id,
                status: "REQUESTED",
                expiresAt: new Date(Date.now() + DEFAULT_EXPIRES_IN_SECONDS * 1000),
            },
        });

        await subject.linkInstance?.(instance.id);

        this.logger.info("Calling up on SDK endpoint", {
            applicationId,
            scenarioName: scenario.name,
            instanceId: instance.id,
        });

        let response: UpResponse;
        try {
            response = await sdkClient.up(
                { instanceId: instance.id, create: createPayload as Record<string, unknown[]> },
                sdkOptions,
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error("Scenario up failed", { error: message, instanceId: instance.id });
            return this.markUpFailure(instance.id, message);
        }

        this.logger.info("Scenario up succeeded", { instanceId: instance.id });
        return this.markUpSuccess(instance.id, response, createPayload, resolvedVariables);
    }

    async down(scenarioInstanceId: string, options?: SdkCallOptions): Promise<ScenarioInstance | undefined> {
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
        const sdkClient = this.createSdkClient(applicationData);

        this.logger.info("Calling down on SDK endpoint", { scenarioInstanceId, instanceId: instance.id });

        try {
            await sdkClient.down(
                {
                    instanceId: instance.id,
                    refs: (instance.refs as Record<string, unknown>) ?? null,
                    refsToken: instance.refsToken ?? undefined,
                },
                options,
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error("Scenario down failed", { error: message, instanceId: instance.id });
            return this.markDownFailure(instance.id, message);
        }

        this.logger.info("Scenario down succeeded", { instanceId: instance.id });
        return this.markDownSuccess(instance.id);
    }

    // -----------------------------------------------------------------------
    // Instance state transitions. Each method writes one row of the state
    // machine: REQUESTED -> UP_SUCCESS | UP_FAILED -> DOWN_SUCCESS | DOWN_FAILED.
    // -----------------------------------------------------------------------

    private markUpSuccess(
        instanceId: string,
        response: UpResponse,
        createPayload: unknown,
        resolvedVariables: Record<string, ScenarioVariableScalar>,
    ): Promise<ScenarioInstance> {
        const expiresInSeconds = response.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
        const hasResolvedVariables = Object.keys(resolvedVariables).length > 0;
        return this.db.scenarioInstance.update({
            where: { id: instanceId },
            data: {
                status: "UP_SUCCESS",
                upAt: new Date(),
                expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
                auth: response.auth,
                refs: response.refs,
                refsToken: response.refsToken,
                metadata: response.metadata,
                generatedData: createPayload,
                ...(hasResolvedVariables ? { resolvedVariables } : {}),
            },
        });
    }

    private markUpFailure(instanceId: string, message: string): Promise<ScenarioInstance> {
        return this.db.scenarioInstance.update({
            where: { id: instanceId },
            data: {
                status: "UP_FAILED",
                lastError: { message },
                completedAt: new Date(),
            },
        });
    }

    private markDownSuccess(instanceId: string): Promise<ScenarioInstance> {
        return this.db.scenarioInstance.update({
            where: { id: instanceId },
            data: {
                status: "DOWN_SUCCESS",
                downAt: new Date(),
                completedAt: new Date(),
            },
        });
    }

    private markDownFailure(instanceId: string, message: string): Promise<ScenarioInstance> {
        return this.db.scenarioInstance.update({
            where: { id: instanceId },
            data: {
                status: "DOWN_FAILED",
                downAt: new Date(),
                completedAt: new Date(),
                lastError: { message },
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
            throw new Error(`Deployment ${deploymentId} does not have an SDK URL configured`);
        }

        return {
            applicationId: application.id,
            deploymentId: deployment.id,
            organizationId: application.organizationId,
            sdkUrl: deployment.webhookUrl,
            signingSecretEnc: application.signingSecretEnc,
            sdkHeaders: (deployment.webhookHeaders as Record<string, string> | undefined) ?? undefined,
        };
    }

    private createSdkClient(applicationData: ScenarioApplicationData): SdkClient {
        const signingSecret = this.encryption.decrypt(applicationData.signingSecretEnc);
        return new SdkClient({
            applicationId: applicationData.applicationId,
            sdkUrl: applicationData.sdkUrl,
            signingSecret,
            customHeaders: applicationData.sdkHeaders,
            recorder: this.recorder,
        });
    }
}
