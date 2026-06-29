import { randomBytes } from "node:crypto";
import type { PreviewkitStatus, PrismaClient } from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import { type EncryptionHelper, type ScenarioManager, type SdkCallOptions, SdkClient } from "@autonoma/scenario";
import type { PreviewConfig } from "@autonoma/types";
import { resolvePreviewkitBypassToken } from "@autonoma/utils";
import { env } from "../../env";
import { DryRunSubject } from "./dry-run-subject";
import type { OnboardingManagerOptions, PreviewkitSecretsUpsertResult } from "./onboarding-dependencies";
import { listSdkDryRunTargets } from "./sdk-dry-run-targets";
import { OnboardingApplicationNotFoundError, type ScenarioDryRunResult } from "./states/onboarding-state";

/**
 * Raised timeout handles typical cold-start latency on the customer's SDK
 * endpoint (discover provisions nothing but may boot the app).
 */
const DRY_RUN_SDK_OPTIONS: SdkCallOptions = {
    timeoutMs: 90_000,
};

/**
 * If a discover has been in flight (a non-null `discoveringStartedAt`) for
 * longer than this, assume the API died mid-call and clear the flag so the
 * Finish setup tab isn't stuck showing "discovering" forever.
 */
const DISCOVERING_TIMEOUT_MS = 2 * 60 * 1000;
const MANAGED_SHARED_SECRET_KEY = "AUTONOMA_SHARED_SECRET";
const MANAGED_SIGNING_SECRET_KEY = "AUTONOMA_SIGNING_SECRET";

export type ConfigureAndDiscoverSdkTargetResult = { status: "discovered" };

/**
 * Result of preparing a managed target: the env is ready to validate, or a
 * redeploy was just kicked off to mount freshly-provisioned secrets (the caller
 * polls the target status to know when it flips back to ready).
 */
export type PrepareSdkTargetResult = { status: "ready" | "redeploy_started" };

/**
 * SDK implementation + dry-run validation as **app-level capabilities**, decoupled
 * from the linear onboarding `step`. The user runs these from the "Finish setup"
 * tab whenever they choose (after going live), so success is tracked with
 * timestamps (`lastDiscoveredAt`, `dryRunPassedAt`) instead of advancing the
 * onboarding state machine.
 */
export class OnboardingSdkCapabilityService {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly scenarioManager: ScenarioManager,
        private readonly encryption: EncryptionHelper,
        private readonly options: OnboardingManagerOptions = {},
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    static isDiscoveryStuck(startedAt: Date | null | undefined): boolean {
        if (startedAt == null) return false;
        return Date.now() - startedAt.getTime() > DISCOVERING_TIMEOUT_MS;
    }

    /**
     * Validate the supplied SDK config by calling discover, then persist it on
     * success. The endpoint is the chosen preview env URL + the fixed
     * `/api/autonoma` path (built by the caller). On failure the config is never
     * persisted and `lastDiscoveryError` is populated. Never touches `step`.
     */
    async configureAndDiscover(
        applicationId: string,
        organizationId: string,
        webhookUrl: string,
        signingSecret: string,
        webhookHeaders?: Record<string, string>,
    ): Promise<void> {
        this.logger.info("Validating SDK config via discover", { applicationId, organizationId });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true, mainBranch: { select: { deployment: { select: { id: true } } } } },
        });
        if (app == null) throw new OnboardingApplicationNotFoundError(applicationId);

        const deploymentId = app.mainBranch?.deployment?.id;
        if (deploymentId == null) {
            throw new Error(`Application ${applicationId} does not have a main branch deployment`);
        }

        await this.db.onboardingState.update({
            where: { applicationId },
            data: { discoveringStartedAt: new Date() },
        });

        try {
            const sdkClient = new SdkClient({
                applicationId,
                sdkUrl: webhookUrl,
                signingSecret,
                customHeaders: webhookHeaders,
            });
            const response = await sdkClient.discover(DRY_RUN_SDK_OPTIONS);

            const signingSecretEnc = this.encryption.encrypt(signingSecret);
            await this.db.$transaction([
                this.db.application.update({ where: { id: applicationId }, data: { signingSecretEnc } }),
                this.db.branchDeployment.update({
                    where: { id: deploymentId },
                    data: { webhookUrl, webhookHeaders: webhookHeaders ?? undefined },
                }),
                this.db.onboardingState.update({
                    where: { applicationId },
                    data: {
                        discoveringStartedAt: null,
                        lastDiscoveredAt: new Date(),
                        lastDiscoveredModels: response.schema.models.length,
                        lastDiscoveryError: null,
                    },
                }),
            ]);
            this.logger.info("Discovery succeeded; SDK config persisted", {
                applicationId,
                modelCount: response.schema.models.length,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Discovery failed; leaving SDK unconfigured", { applicationId, error: message });
            await this.db.onboardingState.update({
                where: { applicationId },
                data: { discoveringStartedAt: null, lastDiscoveryError: message },
            });
            throw err;
        }
    }

    /**
     * Provision the managed target's secrets so it is ready to validate, without
     * touching the user. Autonoma owns both secrets for a PreviewKit-managed env:
     * `AUTONOMA_SHARED_SECRET` (the app's shared secret) is mounted, and
     * `AUTONOMA_SIGNING_SECRET` is generated and saved if it does not exist yet
     * (rotatable later in Settings -> Secrets). If mounting either secret changes
     * the deployed app, a redeploy is kicked off and the caller polls the target
     * status to know when it is ready again. Idempotent: once both secrets are
     * present and unchanged, this is a no-op that returns `ready`.
     */
    async prepareManagedTarget(
        applicationId: string,
        organizationId: string,
        targetId: string,
    ): Promise<PrepareSdkTargetResult> {
        this.logger.info("Preparing managed SDK target", { applicationId, organizationId, targetId });

        const context = await this.resolveManagedTargetContext(applicationId, organizationId, targetId);
        const sharedSecret = await this.loadApplicationSharedSecret(applicationId, organizationId, true);

        const sharedResult = await this.upsertManagedSharedSecret(
            applicationId,
            organizationId,
            context.sdkAppName,
            sharedSecret,
            true,
        );
        const signingResult = await this.ensureManagedSigningSecret(
            applicationId,
            organizationId,
            context.sdkAppName,
            sharedSecret,
        );

        const secretChanged = sharedResult?.changed === true || signingResult?.changed === true;
        const deployIsStale = await this.isManagedDeployStaleVsSecrets(
            applicationId,
            context.sdkAppName,
            context.deployedAt,
        );
        const targetIsLive = context.status === "ready" || context.deployedAt != null;
        if ((secretChanged || deployIsStale) && targetIsLive) {
            await this.redeployManagedTarget(context.repoFullName, context.prNumber, organizationId);
            this.logger.info("Managed target needs fresh secrets; redeploy started", {
                applicationId,
                targetId,
                extra: { secretChanged, deployIsStale },
            });
            return { status: "redeploy_started" };
        }

        this.logger.info("Managed target ready to validate", { applicationId, targetId });
        return { status: "ready" };
    }

    /**
     * PreviewKit-managed variant of `configureAndDiscover`: the browser sends
     * only a target id. The SDK URL, shared secret, and bypass headers are
     * resolved server-side and discovery runs against the prepared preview env.
     * Secrets are provisioned by `prepareManagedTarget` (auto-run when the step
     * loads), so this only validates - it never redeploys.
     */
    async configureAndDiscoverTarget(
        applicationId: string,
        organizationId: string,
        targetId: string,
    ): Promise<ConfigureAndDiscoverSdkTargetResult> {
        this.logger.info("Validating managed SDK target via discover", { applicationId, organizationId, targetId });

        const context = await this.resolveManagedTargetContext(applicationId, organizationId, targetId);
        const sharedSecret = await this.loadApplicationSharedSecret(applicationId, organizationId, true);
        await this.markDiscovering(applicationId);

        try {
            const sdkClient = new SdkClient({
                applicationId,
                sdkUrl: context.sdkUrl,
                signingSecret: sharedSecret,
                customHeaders: buildBypassHeaders(context.bypassToken),
            });
            const response = await sdkClient.discover(DRY_RUN_SDK_OPTIONS);

            await this.persistDiscoveredConfig(
                applicationId,
                context.deploymentId,
                context.sdkUrl,
                context.bypassToken,
                response.schema.models.length,
            );
            this.logger.info("Managed discovery succeeded; SDK config persisted", {
                applicationId,
                modelCount: response.schema.models.length,
            });
            return { status: "discovered" };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Managed discovery failed; leaving SDK target unconfigured", {
                applicationId,
                error: message,
            });
            await this.db.onboardingState.update({
                where: { applicationId },
                data: { discoveringStartedAt: null, lastDiscoveryError: message },
            });
            throw err;
        }
    }

    /**
     * Provision BOTH managed secrets for the primary PreviewKit app the moment
     * the preview config is saved: `AUTONOMA_SHARED_SECRET` (the app's shared
     * secret, used to verify Autonoma's incoming HMAC) and
     * `AUTONOMA_SIGNING_SECRET` (generated once, used by the SDK to sign refs
     * tokens). Writing both here - before the preview's first deploy - lets the
     * PreviewKit ExternalSecret bridge mount them on that initial deploy, so the
     * running pod has both from the start instead of booting with only the
     * shared secret and a redeploy gap for the signing secret. Best-effort: a
     * no-op when the app has no shared secret or PreviewKit secrets are not
     * configured for this environment.
     */
    async ensureManagedSharedSecretForConfig(
        applicationId: string,
        organizationId: string,
        config: PreviewConfig,
    ): Promise<void> {
        const sdkAppName = resolveSdkAppName(config);
        if (sdkAppName == null) return;

        const sharedSecret = await this.loadApplicationSharedSecret(applicationId, organizationId, false);
        if (sharedSecret == null) return;

        if (this.options.previewkitSecretsService == null) {
            this.logger.warn("Skipping managed secret sync because PreviewKit secrets are not configured", {
                applicationId,
                extra: { sdkAppName },
            });
            return;
        }

        await this.upsertManagedSharedSecret(applicationId, organizationId, sdkAppName, sharedSecret, true);
        await this.ensureManagedSigningSecret(applicationId, organizationId, sdkAppName, sharedSecret);
    }

    /**
     * Execute a scenario up + down cycle. On success records `dryRunPassedAt`.
     * Never touches `step`.
     *
     * When `targetId` is supplied, the chosen preview env's SDK URL is resolved
     * server-side and persisted on the main-branch deployment before running, so
     * the dry run hits that target (the auto-detected `feat: autonoma-sdk` PR or
     * main) reusing the stored signing secret. Without it, the last configured
     * endpoint is used.
     */
    async runDryRun(
        applicationId: string,
        organizationId: string,
        scenarioId: string,
        targetId?: string,
    ): Promise<ScenarioDryRunResult> {
        this.logger.info("Running scenario dry run", { applicationId, scenarioId, organizationId, targetId });

        if (targetId != null) {
            await this.pointDeploymentAtTarget(applicationId, organizationId, targetId);
        }

        const subject = new DryRunSubject(this.db, applicationId);
        const instance = await this.scenarioManager.up(subject, scenarioId, { sdkOptions: DRY_RUN_SDK_OPTIONS });
        if (instance.status === "UP_FAILED") {
            return { success: false, phase: "up", error: instance.lastError };
        }

        const downResult = await this.scenarioManager.down(instance.id, DRY_RUN_SDK_OPTIONS);
        if (downResult?.status === "DOWN_FAILED") {
            return { success: false, phase: "down", error: downResult.lastError };
        }

        await this.db.onboardingState.update({
            where: { applicationId },
            data: { dryRunPassedAt: new Date() },
        });
        return { success: true, phase: "down", error: undefined };
    }

    /**
     * Resolve the chosen dry-run target's SDK URL server-side (never trusting a
     * client-supplied URL) and persist it on the main-branch deployment, mirroring
     * what configureAndDiscover does so the existing resolveSdkConfig path picks it
     * up. The stored signing secret is reused unchanged.
     */
    private async pointDeploymentAtTarget(
        applicationId: string,
        organizationId: string,
        targetId: string,
    ): Promise<void> {
        const { targets } = await listSdkDryRunTargets(this.db, applicationId, organizationId);
        const target = targets.find((candidate) => candidate.id === targetId);
        if (target == null) {
            throw new BadRequestError(`Unknown dry-run target "${targetId}"`);
        }

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { mainBranch: { select: { deployment: { select: { id: true } } } } },
        });
        if (app == null) throw new OnboardingApplicationNotFoundError(applicationId);

        const deploymentId = app.mainBranch?.deployment?.id;
        if (deploymentId == null) {
            throw new Error(`Application ${applicationId} does not have a main branch deployment`);
        }

        this.logger.info("Pointing dry-run deployment at target", {
            applicationId,
            targetId,
            extra: { sdkUrl: target.sdkUrl },
        });
        await this.db.branchDeployment.update({
            where: { id: deploymentId },
            data: { webhookUrl: target.sdkUrl },
        });
    }

    private async markDiscovering(applicationId: string): Promise<void> {
        await this.db.onboardingState.update({
            where: { applicationId },
            data: { discoveringStartedAt: new Date() },
        });
    }

    private async persistDiscoveredConfig(
        applicationId: string,
        deploymentId: string,
        webhookUrl: string,
        bypassToken: string | null,
        modelCount: number,
    ): Promise<void> {
        await this.db.$transaction([
            this.db.branchDeployment.update({
                where: { id: deploymentId },
                data: { webhookUrl, webhookHeaders: buildBypassHeaders(bypassToken) },
            }),
            this.db.onboardingState.update({
                where: { applicationId },
                data: {
                    discoveringStartedAt: null,
                    lastDiscoveredAt: new Date(),
                    lastDiscoveredModels: modelCount,
                    lastDiscoveryError: null,
                },
            }),
        ]);
    }

    private async resolveManagedTargetContext(
        applicationId: string,
        organizationId: string,
        targetId: string,
    ): Promise<{
        sdkUrl: string;
        sdkAppName: string;
        deploymentId: string;
        environmentId: string;
        repoFullName: string;
        prNumber: number;
        status: PreviewkitStatus;
        deployedAt: Date | null;
        bypassToken: string | null;
    }> {
        const { targets } = await listSdkDryRunTargets(this.db, applicationId, organizationId);
        const target = targets.find((candidate) => candidate.id === targetId);
        if (target == null) {
            throw new BadRequestError(`Unknown SDK target "${targetId}"`);
        }
        if (target.source !== "previewkit" || target.environmentId == null || target.sdkAppName == null) {
            throw new BadRequestError(`SDK target "${targetId}" is not managed by PreviewKit`);
        }

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { mainBranch: { select: { deployment: { select: { id: true } } } } },
        });
        if (app == null) throw new OnboardingApplicationNotFoundError(applicationId);

        const deploymentId = app.mainBranch?.deployment?.id;
        if (deploymentId == null) {
            throw new Error(`Application ${applicationId} does not have a main branch deployment`);
        }

        const environment = await this.db.previewkitEnvironment.findFirst({
            where: { id: target.environmentId, organizationId },
            select: {
                id: true,
                repoFullName: true,
                prNumber: true,
                status: true,
                deployedAt: true,
                bypassToken: true,
            },
        });
        if (environment == null) {
            throw new BadRequestError(`PreviewKit environment for target "${targetId}" was not found`);
        }

        return {
            sdkUrl: target.sdkUrl,
            sdkAppName: target.sdkAppName,
            deploymentId,
            environmentId: environment.id,
            repoFullName: environment.repoFullName,
            prNumber: environment.prNumber,
            status: environment.status,
            deployedAt: environment.deployedAt,
            bypassToken: environment.bypassToken,
        };
    }

    /**
     * A managed preview only mounts its secrets at deploy time, so a secret
     * bundle provisioned after the env was deployed leaves the running pod
     * stale. Returns true when the env's secret bundle was last written after
     * its current deploy. Conservative: returns false when the deploy time or
     * the secret bundle is unknown (callers fall back to the `secretChanged`
     * signal in that case).
     */
    private async isManagedDeployStaleVsSecrets(
        applicationId: string,
        sdkAppName: string,
        deployedAt: Date | null,
    ): Promise<boolean> {
        if (deployedAt == null) return false;
        const secret = await this.db.previewkitSecret.findUnique({
            where: { applicationId_appName: { applicationId, appName: sdkAppName } },
            select: { updatedAt: true },
        });
        if (secret == null) return false;
        return secret.updatedAt.getTime() > deployedAt.getTime();
    }

    private async loadApplicationSharedSecret(
        applicationId: string,
        organizationId: string,
        required: true,
    ): Promise<string>;
    private async loadApplicationSharedSecret(
        applicationId: string,
        organizationId: string,
        required: false,
    ): Promise<string | undefined>;
    private async loadApplicationSharedSecret(
        applicationId: string,
        organizationId: string,
        required: boolean,
    ): Promise<string | undefined> {
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { signingSecretEnc: true },
        });
        if (application == null) throw new OnboardingApplicationNotFoundError(applicationId);
        if (application.signingSecretEnc == null) {
            if (required) throw new BadRequestError("Application has no shared secret");
            this.logger.warn("Skipping managed shared secret sync because the application has no shared secret", {
                applicationId,
            });
            return undefined;
        }
        return this.encryption.decrypt(application.signingSecretEnc);
    }

    private async upsertManagedSharedSecret(
        applicationId: string,
        organizationId: string,
        sdkAppName: string,
        sharedSecret: string,
        required: boolean,
    ): Promise<PreviewkitSecretsUpsertResult | undefined> {
        const service = this.options.previewkitSecretsService;
        if (service == null) {
            if (required) throw new BadRequestError("PreviewKit secrets are not configured for this environment");
            this.logger.warn("Skipping managed shared secret sync because PreviewKit secrets are not configured", {
                applicationId,
                sdkAppName,
            });
            return undefined;
        }

        const result = await service.upsert(
            applicationId,
            sdkAppName,
            [{ key: MANAGED_SHARED_SECRET_KEY, value: sharedSecret }],
            organizationId,
        );
        if (result == null) return undefined;
        return result;
    }

    /**
     * Ensure AUTONOMA_SIGNING_SECRET exists for the managed app, generating and
     * saving one (distinct from the shared secret) when it is missing. Returns the
     * upsert result when a secret was created (so the caller can redeploy), or
     * `undefined` when it already existed (no change, no redeploy).
     */
    private async ensureManagedSigningSecret(
        applicationId: string,
        organizationId: string,
        sdkAppName: string,
        sharedSecret: string,
    ): Promise<PreviewkitSecretsUpsertResult | undefined> {
        const service = this.options.previewkitSecretsService;
        if (service == null) {
            throw new BadRequestError("PreviewKit secrets are not configured for this environment");
        }

        const secrets = await service.list(applicationId, sdkAppName, organizationId);
        const hasSigningSecret = secrets.some((secret) => secret.key === MANAGED_SIGNING_SECRET_KEY);
        if (hasSigningSecret) return undefined;

        this.logger.info("Generating AUTONOMA_SIGNING_SECRET for managed SDK target", { applicationId, sdkAppName });
        const signingSecret = generateManagedSigningSecret(sharedSecret);
        return await this.upsertManagedSigningSecret(applicationId, organizationId, sdkAppName, signingSecret);
    }

    private async upsertManagedSigningSecret(
        applicationId: string,
        organizationId: string,
        sdkAppName: string,
        signingSecret: string,
    ): Promise<PreviewkitSecretsUpsertResult | undefined> {
        const service = this.options.previewkitSecretsService;
        if (service == null) {
            throw new BadRequestError("PreviewKit secrets are not configured for this environment");
        }

        const result = await service.upsert(
            applicationId,
            sdkAppName,
            [{ key: MANAGED_SIGNING_SECRET_KEY, value: signingSecret }],
            organizationId,
        );
        if (result == null) return undefined;
        return result;
    }

    private async redeployManagedTarget(repoFullName: string, prNumber: number, organizationId: string): Promise<void> {
        const previewkitClient = this.options.previewkitClient;
        if (previewkitClient == null || !previewkitClient.isConfigured()) {
            throw new BadRequestError("PreviewKit deploys are not configured for this environment");
        }
        await previewkitClient.redeploy(repoFullName, prNumber, organizationId);
    }
}

function resolveSdkAppName(config: PreviewConfig): string | undefined {
    const primary = config.apps.find((app) => app.primary === true);
    return primary?.name ?? config.apps[0]?.name;
}

/**
 * A fresh 256-bit hex signing secret, guaranteed different from the shared secret
 * (the SDK rejects equal secrets). A collision is astronomically unlikely, but the
 * loop keeps the invariant exact rather than probabilistic.
 */
function generateManagedSigningSecret(sharedSecret: string): string {
    let candidate: string;
    do {
        candidate = randomBytes(32).toString("hex");
    } while (candidate === sharedSecret);
    return candidate;
}

function buildBypassHeaders(bypassToken: string | null): Record<string, string> | undefined {
    if (bypassToken == null) return undefined;
    return { "x-previewkit-bypass": resolvePreviewkitBypassToken(bypassToken, env.PREVIEWKIT_BYPASS_TOKEN_KEY) };
}
