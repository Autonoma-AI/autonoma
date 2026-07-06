import { randomBytes } from "node:crypto";
import type { PreviewkitStatus, PrismaClient } from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import {
    type EncryptionHelper,
    type ScenarioManager,
    type SdkCallOptions,
    SdkClient,
    SdkHttpError,
} from "@autonoma/scenario";
import type { PreviewConfig } from "@autonoma/types";
import { resolvePreviewkitBypassToken } from "@autonoma/utils";
import { env } from "../../env";
import { DryRunSubject } from "./dry-run-subject";
import type {
    OnboardingManagerOptions,
    OnboardingPreviewkitSecretsService,
    PreviewkitSecretsUpsertResult,
} from "./onboarding-dependencies";
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

/**
 * Result of validating a managed target via discover: the SDK schema was
 * discovered and the config persisted, or a 401 signalled shared-secret drift
 * between our signer and the deployed pod and we kicked off a self-healing
 * redeploy (the caller polls the target status and retries once it is ready).
 */
export type ConfigureAndDiscoverSdkTargetResult = { status: "discovered" } | { status: "redeploy_started" };

/**
 * Result of preparing a managed target: the env is ready to validate, or a
 * redeploy was just kicked off to mount freshly-provisioned secrets (the caller
 * polls the target status to know when it flips back to ready).
 */
export type PrepareSdkTargetResult = { status: "ready" | "redeploy_started" };

/**
 * Resolved, server-side view of a PreviewKit-managed SDK target: the SDK URL to
 * call, the secret-bundle app name, the linked deployment, and the underlying
 * preview environment's identity and current deploy state.
 */
interface ManagedTargetContext {
    sdkUrl: string;
    sdkAppName: string;
    deploymentId: string;
    environmentId: string;
    repoFullName: string;
    prNumber: number;
    status: PreviewkitStatus;
    deployedAt: Date | null;
    bypassToken: string | null;
}

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
            await this.redeployManagedTarget(
                context.environmentId,
                context.repoFullName,
                context.prNumber,
                organizationId,
            );
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
     * loads), so on the happy path this only validates.
     *
     * The deployer is the source of truth: it force-syncs ESO and waits for the
     * pod's secret to be live before a preview is `ready`, so on the happy path
     * this only validates and persists. `allowSelfHeal` is a bounded fallback for
     * legacy previews deployed before that gate existed: on the user's FIRST
     * click (`allowSelfHeal = true`) a 401 "Invalid HMAC signature" - which for a
     * managed target can only be our own secret drift - triggers one redeploy and
     * returns `redeploy_started`. The frontend's single auto-retry passes
     * `allowSelfHeal = false`, so if the 401 survives the redeploy it is persisted
     * and surfaced to the user instead of looping on redeploys.
     */
    async configureAndDiscoverTarget(
        applicationId: string,
        organizationId: string,
        targetId: string,
        allowSelfHeal: boolean,
    ): Promise<ConfigureAndDiscoverSdkTargetResult> {
        this.logger.info("Validating managed SDK target via discover", {
            applicationId,
            organizationId,
            targetId,
            extra: { allowSelfHeal },
        });

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
            const isManagedSecretDrift = err instanceof SdkHttpError && err.status === 401 && isInvalidHmacError(err);
            if (isManagedSecretDrift && allowSelfHeal) {
                return await this.selfHealManagedDiscover401(applicationId, organizationId, context, sharedSecret);
            }
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
     * Handle a managed discover 401: the deployed pod's verifier secret does not
     * match what we signed with. For a managed target we own both sides, so a 401
     * is our own drift, not a customer failure - and the 401 is the only reliable
     * signal of it. DB / AWS-SM state can look perfectly current while the running
     * pod still holds a stale or missing `AUTONOMA_SHARED_SECRET` it captured at
     * boot (env vars are read once at pod start), so a staleness check on those
     * sources would miss the very case that produces this 401.
     *
     * We re-provision the secrets to AWS SM (so the source is current), then
     * redeploy - which flips the env status so the caller's poll waits through
     * the rollout, forces ESO to re-sync, and rolls the pod onto the current
     * secret - and return `redeploy_started` without writing a terminal error.
     * The caller only reaches this with `allowSelfHeal = true` (the user's first
     * click); the single auto-retry passes `allowSelfHeal = false`, so a 401 that
     * survives the redeploy is persisted and surfaced instead of looping.
     */
    private async selfHealManagedDiscover401(
        applicationId: string,
        organizationId: string,
        context: ManagedTargetContext,
        sharedSecret: string,
    ): Promise<ConfigureAndDiscoverSdkTargetResult> {
        await this.upsertManagedSharedSecret(applicationId, organizationId, context.sdkAppName, sharedSecret, true);
        await this.ensureManagedSigningSecret(applicationId, organizationId, context.sdkAppName, sharedSecret);

        this.logger.info("Managed discover 401; re-provisioning secrets and redeploying to self-heal", {
            applicationId,
            extra: { environmentId: context.environmentId, status: context.status },
        });
        await this.redeployManagedTarget(context.environmentId, context.repoFullName, context.prNumber, organizationId);
        await this.db.onboardingState.update({
            where: { applicationId },
            data: { discoveringStartedAt: null, lastDiscoveryError: null },
        });
        return { status: "redeploy_started" };
    }

    /**
     * Provision BOTH managed secrets for EVERY app in the preview config the
     * moment it is saved: `AUTONOMA_SHARED_SECRET` (the app's shared secret, used
     * to verify Autonoma's incoming HMAC) and `AUTONOMA_SIGNING_SECRET` (used by
     * the SDK to sign refs tokens). The Environment Factory handler can live in
     * any app of a monorepo, so both are fanned out to every app's secret bundle
     * rather than only the primary's - each app pod then boots with the pair and
     * a handler running anywhere verifies/signs correctly. The signing secret is
     * one logical value: it is resolved once (reusing an existing value from any
     * app's bundle - canonical first - so a rotation survives, else minting a
     * fresh one) and the SAME value is written to every bundle. `services` are
     * infra recipes (postgres, redis, ...), never customer handler code, so they
     * are intentionally excluded.
     *
     * Writing here - before the preview's first deploy - lets the PreviewKit
     * ExternalSecret bridge mount both on that initial deploy, so pods have them
     * from the start instead of a redeploy gap. Best-effort: a no-op when the app
     * has no shared secret or PreviewKit secrets are not configured.
     */
    async ensureManagedSharedSecretForConfig(
        applicationId: string,
        organizationId: string,
        config: PreviewConfig,
    ): Promise<void> {
        const canonicalAppName = resolveSdkAppName(config);
        if (canonicalAppName == null) return;
        const appNames = config.apps.map((app) => app.name);

        const sharedSecret = await this.loadApplicationSharedSecret(applicationId, organizationId, false);
        if (sharedSecret == null) return;

        const service = this.options.previewkitSecretsService;
        if (service == null) {
            this.logger.warn("Skipping managed secret sync because PreviewKit secrets are not configured", {
                applicationId,
                extra: { appNames },
            });
            return;
        }

        const orderedAppNames = [canonicalAppName, ...appNames.filter((name) => name !== canonicalAppName)];
        const signingSecret = await this.resolveManagedSigningSecret(
            service,
            applicationId,
            organizationId,
            orderedAppNames,
            sharedSecret,
        );

        this.logger.info("Fanning managed secrets out to all preview apps", {
            applicationId,
            extra: { appNames, canonicalAppName },
        });
        for (const appName of appNames) {
            await service.upsert(
                applicationId,
                appName,
                [
                    { key: MANAGED_SHARED_SECRET_KEY, value: sharedSecret },
                    { key: MANAGED_SIGNING_SECRET_KEY, value: signingSecret },
                ],
                organizationId,
            );
        }
    }

    private async resolveManagedSigningSecret(
        service: OnboardingPreviewkitSecretsService,
        applicationId: string,
        organizationId: string,
        appNames: string[],
        sharedSecret: string,
    ): Promise<string> {
        for (const appName of appNames) {
            const existing = await service.getValue?.(
                applicationId,
                appName,
                MANAGED_SIGNING_SECRET_KEY,
                organizationId,
            );
            if (existing != null) return existing;
        }

        this.logger.info("Minting AUTONOMA_SIGNING_SECRET for managed preview apps", {
            applicationId,
            extra: { appNames },
        });
        return generateManagedSigningSecret(sharedSecret);
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
    ): Promise<ManagedTargetContext> {
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
     * its current deploy.
     *
     * When there is no secret bundle at all there is nothing to mount, so this
     * returns false (callers fall back to the `secretChanged` signal). But when a
     * bundle exists with no recorded deploy time, we cannot prove the pod booted
     * after the secret landed, so we err toward stale (true) and let the caller
     * redeploy rather than risk validating against a pod with a stale secret.
     */
    private async isManagedDeployStaleVsSecrets(
        applicationId: string,
        sdkAppName: string,
        deployedAt: Date | null,
    ): Promise<boolean> {
        const secret = await this.db.previewkitSecret.findUnique({
            where: { applicationId_appName: { applicationId, appName: sdkAppName } },
            select: { updatedAt: true },
        });
        if (secret == null) return false;
        if (deployedAt == null) return true;
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

    private async redeployManagedTarget(
        environmentId: string,
        repoFullName: string,
        prNumber: number,
        organizationId: string,
    ): Promise<void> {
        const previewkitClient = this.options.previewkitClient;
        if (previewkitClient == null || !previewkitClient.isConfigured()) {
            throw new BadRequestError("PreviewKit deploys are not configured for this environment");
        }
        await previewkitClient.redeploy(repoFullName, prNumber, organizationId);
        // The redeploy is fire-and-forget - it launches a K8s Job and returns;
        // status/deployedAt only flip to "ready" when that deploy completes. Flip
        // status to a non-ready value now so the frontend's "poll until ready"
        // loop keeps waiting through the rollout instead of racing discover
        // against the old pod (still serving the old secret) -> 401. The deploy
        // Job flips status back to "ready" (or "failed") when it finishes.
        await this.db.previewkitEnvironment.update({
            where: { id: environmentId },
            data: { status: "building" },
        });
        this.logger.info("Managed target redeploy requested; status set to building", {
            extra: { environmentId, repoFullName, prNumber },
        });
    }
}

function resolveSdkAppName(config: PreviewConfig): string | undefined {
    const primary = config.apps.find((app) => app.primary === true);
    return primary?.name ?? config.apps[0]?.name;
}

/**
 * A managed 401 is only our own secret drift when the pod rejected the HMAC.
 * Other 401s (e.g. a Gatekeeper/auth wall in front of the preview) are a
 * different problem we must not paper over with a redeploy, so the self-heal is
 * scoped to the SDK handler's "Invalid HMAC signature" response specifically.
 */
function isInvalidHmacError(error: SdkHttpError): boolean {
    const haystack = `${error.detail ?? ""} ${error.message}`.toLowerCase();
    return haystack.includes("invalid hmac signature");
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
