import { randomUUID } from "node:crypto";
import type { PrismaClient, ScenarioInstance } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import { RefsSchema, type DiscoverResponse, type ScenarioVariableScalar, type UpResponse } from "@autonoma/types";
import { DbSdkCallRecorder } from "./db-sdk-call-recorder";
import type { EncryptionHelper } from "./encryption";
import { ScenarioRecipeStore } from "./scenario-recipe-store";
import type { ScenarioSubject } from "./scenario-subject";
import { SdkClient, type SdkCallOptions } from "./sdk-client";
import { resolveSdkConfig, type SdkConfig } from "./sdk-config-resolver";

const DEFAULT_EXPIRES_IN_SECONDS = 2 * 60 * 60; // 2 hours

interface ScenarioApplicationData {
    organizationId: string;
    sdkConfig: SdkConfig;
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
        opts?: { snapshotId?: string; sdkOptions?: SdkCallOptions; sdkUrlOverride?: string },
    ): Promise<ScenarioInstance> {
        const { snapshotId, sdkOptions, sdkUrlOverride } = opts ?? {};
        const { applicationId, deploymentId } = await subject.resolveDeployment();
        const applicationData = await this.getApplicationDataForDeployment(applicationId, deploymentId, sdkUrlOverride);
        const { organizationId } = applicationData;
        const sdkClient = this.createSdkClient(applicationData);

        // Scope the scenario to the resolved application, not just its id: this is the
        // tenant-isolation boundary for provisioning. Loading by id alone would let a
        // caller run another application's (another org's) recipe against this app.
        const scenario = await this.db.scenario.findFirst({
            where: { id: scenarioId, applicationId },
            select: { id: true, name: true },
        });
        if (scenario == null) {
            throw new Error(`Scenario "${scenarioId}" not found for application "${applicationId}"`);
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
                deploymentId,
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
                    refs: RefsSchema.nullable().catch(null).parse(instance.refs),
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
        sdkUrlOverride?: string,
    ): Promise<ScenarioApplicationData> {
        const sdkConfig = await resolveSdkConfig({
            applicationId,
            deploymentId,
            db: this.db,
            encryption: this.encryption,
            sdkUrlOverride,
        });

        const application = await this.db.application.findUniqueOrThrow({
            where: { id: applicationId },
            select: { organizationId: true },
        });

        return { organizationId: application.organizationId, sdkConfig };
    }

    private createSdkClient(applicationData: ScenarioApplicationData): SdkClient {
        return new SdkClient({
            applicationId: applicationData.sdkConfig.applicationId,
            sdkUrl: applicationData.sdkConfig.sdkUrl,
            signingSecret: applicationData.sdkConfig.signingSecret,
            customHeaders: applicationData.sdkConfig.customHeaders,
            recorder: this.recorder,
        });
    }
}
