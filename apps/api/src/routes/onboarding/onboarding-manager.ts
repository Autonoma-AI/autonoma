import { type OnboardingPreviewEnvironmentMode, type PrismaClient } from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import {
    previewConfigSchema,
    validatePreviewConfigSemantics,
    type PreviewConfig,
    type SecretItem,
} from "@autonoma/types";
import { triggerRefinementLoop } from "@autonoma/workflow";
import { z } from "zod";
import {
    type DeploymentSignalInput,
    isCommitSha,
    parseDeploymentSignalBody,
    verifySignature,
} from "./deployment-signal";
import type { OnboardingManagerOptions, OnboardingPreviewkitSecretsService } from "./onboarding-dependencies";
import {
    buildExistingDeploysReadiness,
    buildPreviewkitReadiness,
    idleReadiness,
    writePreviewUrl,
    type PreviewReadiness,
} from "./preview-readiness";
import {
    PreviewkitConfigService,
    type OnboardingPreviewkitConfig,
    type PreviewkitConfigValidationResult,
    type PreviewkitDependencyDocument,
} from "./previewkit-config-service";
import { CompletedState } from "./states/completed-state";
import { DiscoveredState } from "./states/discovered-state";
import { DiscoveringState } from "./states/discovering-state";
import { DryRunPassedState } from "./states/dry-run-passed-state";
import { ExistingDeploysConfiguringState } from "./states/existing-deploys-configuring-state";
import { ExistingDeploysWaitingState } from "./states/existing-deploys-waiting-state";
import { GitHubState } from "./states/github-state";
import type { OnboardingState, OnboardingStateDeps } from "./states/onboarding-state";
import { PreviewEnvironmentState } from "./states/preview-environment-state";
import { PreviewVerifiedState } from "./states/preview-verified-state";
import { PreviewkitConfiguringState } from "./states/previewkit-configuring-state";
import { PreviewkitDeployingState } from "./states/previewkit-deploying-state";
import { UrlState } from "./states/url-state";
import { WebhookConfiguringState } from "./states/webhook-configuring-state";

/**
 * If a row has been stuck at `discovering` for longer than this, assume the
 * API died mid-call and auto-recover to `webhook_configuring` with an error.
 * Longer than the webhook's own timeout+retry budget, short enough that the
 * user isn't locked out for long after a real crash.
 */
const DISCOVERING_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Ordered list of onboarding steps. Used to determine whether an operation
 * from an earlier step should be allowed when the user is at a later step.
 */
const INITIAL_STEP: OnboardingState["step"] = "webhook_configuring";

const STEP_ORDER: OnboardingState["step"][] = [
    "webhook_configuring",
    "discovering",
    "discovered",
    "dry_run_passed",
    "url",
    "github",
    "preview_environment",
    "previewkit_configuring",
    "previewkit_deploying",
    "existing_deploys_configuring",
    "existing_deploys_waiting",
    "preview_verified",
    "completed",
];

/**
 * Facade for the onboarding state machine.
 *
 * Every public method loads the current {@link OnboardingState} subclass from the
 * database and delegates the operation to it. This keeps the manager thin while
 * the state subclasses enforce which transitions are valid at each step.
 *
 * For backwards-compatible operations (e.g. re-running a scenario dry run from
 * the github step), the manager loads the state that implements the operation
 * instead of the current state. This allows users to go back and redo earlier
 * steps without the state machine rejecting them.
 *
 * Flow: webhook_configuring -> discovered -> dry_run_passed -> github ->
 * preview_environment -> preview_verified -> completed.
 * Reset is available from any step.
 */
export class OnboardingManager {
    private readonly logger: Logger;
    private readonly previewkitConfig: PreviewkitConfigService;

    private static readonly states: Partial<
        Record<
            OnboardingState["step"],
            new (applicationId: string, db: PrismaClient, deps: OnboardingStateDeps) => OnboardingState
        >
    > = {
        webhook_configuring: WebhookConfiguringState,
        discovering: DiscoveringState,
        discovered: DiscoveredState,
        dry_run_passed: DryRunPassedState,
        url: UrlState,
        github: GitHubState,
        preview_environment: PreviewEnvironmentState,
        previewkit_configuring: PreviewkitConfiguringState,
        previewkit_deploying: PreviewkitDeployingState,
        existing_deploys_configuring: ExistingDeploysConfiguringState,
        existing_deploys_waiting: ExistingDeploysWaitingState,
        preview_verified: PreviewVerifiedState,
        completed: CompletedState,
    };

    constructor(
        private readonly db: PrismaClient,
        private readonly scenarioManager: ScenarioManager,
        private readonly encryption: EncryptionHelper,
        private readonly options: OnboardingManagerOptions = {},
    ) {
        this.logger = logger.child({ name: "OnboardingManager" });
        this.previewkitConfig = new PreviewkitConfigService(db, options);
    }

    async getState(applicationId: string) {
        this.logger.info("Getting onboarding state", { applicationId });

        // The upsert and crash-recovery write target the same row and must be
        // consistent under concurrent polling, so run them in one transaction.
        const row = await this.db.$transaction(async (tx) => {
            let current = await tx.onboardingState.upsert({
                where: { applicationId },
                create: { applicationId, step: INITIAL_STEP },
                update: {},
            });

            // Crash recovery: if a prior discover call died mid-flight, the row is
            // stuck at `discovering` with `discoveringStartedAt` set. Roll back to
            // `webhook_configuring` so the user can retry.
            if (current.step === "discovering" && this.isDiscoveryStuck(current.discoveringStartedAt)) {
                this.logger.warn("Recovering stuck `discovering` state", {
                    applicationId,
                    discoveringStartedAt: current.discoveringStartedAt,
                });
                current = await tx.onboardingState.update({
                    where: { applicationId },
                    data: {
                        step: "webhook_configuring",
                        discoveringStartedAt: null,
                        lastDiscoveryError: "Discovery timed out or crashed. Please retry.",
                    },
                });
            }

            return current;
        });

        const stepIndex = STEP_ORDER.indexOf(row.step);
        const discoveredIndex = STEP_ORDER.indexOf("discovered");
        const webhookConfigured = stepIndex >= discoveredIndex;
        const discoveryInProgress = row.step === "discovering";

        return { ...row, webhookConfigured, discoveryInProgress };
    }

    private isDiscoveryStuck(startedAt: Date | null): boolean {
        if (startedAt == null) return false;
        return Date.now() - startedAt.getTime() > DISCOVERING_TIMEOUT_MS;
    }

    /** Return the agent log entries for the application. */
    async getLogs(applicationId: string) {
        const row = await this.db.onboardingState.findUnique({
            where: { applicationId },
            select: { agentLogs: true },
        });

        return { logs: row?.agentLogs ?? [] };
    }

    /** Store the production URL, move from `url` to `github`. Works from url or any later step. */
    async setUrl(applicationId: string, productionUrl: string) {
        this.logger.info("Setting production URL", { applicationId });
        const state = await this.loadStateOrEarlier(applicationId, "url");
        await state.setUrl(productionUrl);
        return this.getState(applicationId);
    }

    /** Move from `github` to `preview_environment`. Works from github or any later step. */
    async completeGithub(applicationId: string, organizationId: string) {
        this.logger.info("Completing GitHub step", { applicationId });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        const state = await this.loadStateOrEarlier(applicationId, "github");
        await state.completeGithub();
        return this.getState(applicationId);
    }

    async selectPreviewEnvironmentMode(
        applicationId: string,
        organizationId: string,
        mode: OnboardingPreviewEnvironmentMode,
    ) {
        this.logger.info("Selecting onboarding preview environment mode", { applicationId, mode });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        const state = await this.loadStateOrEarlier(applicationId, "preview_environment");
        await state.selectPreviewEnvironmentMode(mode);
        return this.getState(applicationId);
    }

    /**
     * Existing-deploys path: advance from `existing_deploys_configuring` to
     * `existing_deploys_waiting`. Uses the actual current state (not an earlier
     * one) so a signal that already advanced the row to `preview_verified` is
     * never rolled back; the waiting state treats the call as idempotent.
     */
    async confirmExistingDeploysSetup(applicationId: string, organizationId: string) {
        this.logger.info("Confirming existing-deploys setup", { applicationId });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        const state = await this.loadState(applicationId);
        await state.confirmExistingDeploysSetup();
        return this.getState(applicationId);
    }

    async getPreviewkitConfig(applicationId: string, organizationId: string): Promise<OnboardingPreviewkitConfig> {
        this.logger.info("Loading onboarding PreviewKit config", { applicationId, organizationId });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        return this.previewkitConfig.getConfig(applicationId, organizationId);
    }

    async savePreviewkitConfig(
        applicationId: string,
        organizationId: string,
        document: unknown,
        userId: string,
        dependencyDocuments: PreviewkitDependencyDocument[] = [],
    ): Promise<OnboardingPreviewkitConfig> {
        this.logger.info("Saving onboarding PreviewKit config", { applicationId, organizationId });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        await this.ensureStateAtOrAfter(applicationId, "previewkit_configuring", "save PreviewKit config");
        return this.previewkitConfig.save(applicationId, organizationId, document, userId, dependencyDocuments);
    }

    async validatePreviewkitConfig(
        applicationId: string,
        organizationId: string,
        document: unknown,
        githubRepositoryId?: number,
    ): Promise<PreviewkitConfigValidationResult> {
        this.logger.info("Validating onboarding PreviewKit config", { applicationId, organizationId });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        return this.previewkitConfig.validate(applicationId, organizationId, document, githubRepositoryId);
    }

    async listPreviewkitSecrets(applicationId: string, organizationId: string, appName: string) {
        this.logger.info("Listing onboarding PreviewKit secrets", { applicationId, organizationId, appName });
        await this.ensureApplicationOwnsPreviewkitApp(applicationId, organizationId, appName);
        return this.requirePreviewkitSecretsService().list(applicationId, appName, organizationId);
    }

    async upsertPreviewkitSecrets(applicationId: string, organizationId: string, appName: string, items: SecretItem[]) {
        this.logger.info("Upserting onboarding PreviewKit secrets", {
            applicationId,
            organizationId,
            appName,
            count: items.length,
        });
        await this.ensureApplicationOwnsPreviewkitApp(applicationId, organizationId, appName);
        await this.requirePreviewkitSecretsService().upsert(applicationId, appName, items, organizationId);
        return this.listPreviewkitSecrets(applicationId, organizationId, appName);
    }

    async deletePreviewkitSecret(applicationId: string, organizationId: string, appName: string, key: string) {
        this.logger.info("Deleting onboarding PreviewKit secret", { applicationId, organizationId, appName, key });
        await this.ensureApplicationOwnsPreviewkitApp(applicationId, organizationId, appName);
        await this.requirePreviewkitSecretsService().delete(applicationId, appName, key, organizationId);
        return this.listPreviewkitSecrets(applicationId, organizationId, appName);
    }

    async triggerPreviewkitMainDeploy(applicationId: string, organizationId: string) {
        this.logger.info("Triggering PreviewKit main branch onboarding deploy", { applicationId, organizationId });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        await this.ensureStateAtOrAfter(applicationId, "previewkit_configuring", "trigger PreviewKit deploy");

        const previewkitClient = this.options.previewkitClient;
        if (previewkitClient == null || !previewkitClient.isConfigured()) {
            throw new BadRequestError("PreviewKit is not configured for this environment");
        }

        const activeConfig = await this.ensureActivePreviewkitConfig(applicationId, organizationId);
        const blockingIssues = validatePreviewConfigSemantics(activeConfig).filter(
            (issue) => issue.severity === "error",
        );
        if (blockingIssues.length > 0) {
            const issueText = blockingIssues
                .map((issue) => {
                    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
                    return `${path}${issue.message}`;
                })
                .join("; ");
            throw new ConflictError(`Active PreviewKit config has blocking issues: ${issueText}`);
        }

        await previewkitClient.deployApplicationMain(applicationId, organizationId);

        await this.db.onboardingState.update({
            where: { applicationId },
            data: {
                step: "previewkit_deploying",
                previewEnvironmentMode: "previewkit",
                previewVerificationStatus: "building",
            },
        });

        return this.getPreviewReadiness(applicationId, organizationId);
    }

    async getPreviewReadiness(applicationId: string, organizationId: string): Promise<PreviewReadiness> {
        this.logger.info("Loading onboarding preview readiness", { applicationId, organizationId });
        const state = await this.db.onboardingState.upsert({
            where: { applicationId },
            create: { applicationId, step: INITIAL_STEP },
            update: {},
        });

        if (state.previewEnvironmentMode === "existing_deploys") {
            return buildExistingDeploysReadiness(
                this.db,
                applicationId,
                state.step,
                state.previewVerificationStatus,
                state.previewUrl ?? state.productionUrl ?? undefined,
            );
        }

        if (state.previewEnvironmentMode !== "previewkit") {
            return idleReadiness(state.previewEnvironmentMode ?? undefined);
        }

        return buildPreviewkitReadiness(
            this.db,
            applicationId,
            organizationId,
            state.step,
            state.previewVerificationStatus,
            state.updatedAt,
        );
    }

    async completePreviewOnboarding(applicationId: string, organizationId: string) {
        this.logger.info("Completing preview onboarding", { applicationId, organizationId });
        const readiness = await this.getPreviewReadiness(applicationId, organizationId);
        if (readiness.diagnostics.status !== "ready") {
            throw new ConflictError("Preview environment is not ready yet");
        }

        const state = await this.loadStateOrEarlier(applicationId, "preview_verified");
        await state.completePreviewOnboarding();
        await this.enqueueGenerations(applicationId, organizationId);
        return this.getState(applicationId);
    }

    async acceptDeploymentSignal(input: DeploymentSignalInput) {
        this.logger.info("Accepting onboarding deployment signal");
        const body = parseDeploymentSignalBody(input.bodyText);
        const application = await this.db.application.findUnique({
            where: { id: body.applicationId },
            select: {
                id: true,
                organizationId: true,
                signingSecretEnc: true,
                mainBranch: { select: { deploymentId: true, name: true } },
                onboardingState: { select: { previewEnvironmentMode: true } },
            },
        });

        if (application == null) throw new NotFoundError("Application not found");
        if (application.signingSecretEnc == null) throw new BadRequestError("Application has no shared secret");

        const signingSecret = this.encryption.decrypt(application.signingSecretEnc);
        if (!verifySignature(input.bodyText, input.signature, signingSecret)) {
            throw new BadRequestError("Invalid signature");
        }

        // Deployment signals only back the existing-deploys path. Reject them for
        // any other mode so a signal can't yank a PreviewKit-mode (or unselected)
        // onboarding straight to verified.
        if (application.onboardingState?.previewEnvironmentMode !== "existing_deploys") {
            throw new ConflictError("Application is not configured for external deployment signals");
        }

        // Only the main branch deploy backs the tracked preview/production URL.
        // Signals for other branches are accepted but ignored, so a sender that
        // reports every branch deploy doesn't clobber the tracked URL.
        const mainBranchName = application.mainBranch?.name;
        const branchIsProviderCommitRef = body.branch != null && isCommitSha(body.branch);
        if (
            body.branch != null &&
            mainBranchName != null &&
            body.branch !== mainBranchName &&
            !branchIsProviderCommitRef
        ) {
            this.logger.info("Ignoring deployment signal for non-main branch", {
                applicationId: application.id,
                signalBranch: body.branch,
                mainBranch: mainBranchName,
            });
            return { ok: true, applicationId: application.id, previewUrl: body.previewUrl, ignored: true };
        }

        await writePreviewUrl(this.db, {
            applicationId: application.id,
            organizationId: application.organizationId,
            previewUrl: body.previewUrl,
        });

        return { ok: true, applicationId: application.id, previewUrl: body.previewUrl, ignored: false };
    }

    async getDeploymentSignalStatus(applicationId: string, organizationId: string) {
        this.logger.info("Loading onboarding deployment signal status", { applicationId, organizationId });
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: {
                onboardingState: {
                    select: {
                        previewUrl: true,
                        previewEnvironmentMode: true,
                        updatedAt: true,
                    },
                },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const state = application.onboardingState;
        if (state == null || state.previewEnvironmentMode !== "existing_deploys" || state.previewUrl == null) {
            return {};
        }

        return {
            previewUrl: state.previewUrl,
            acceptedAt: state.updatedAt.toISOString(),
        };
    }

    async configureAndDiscoverScenarios(
        applicationId: string,
        organizationId: string,
        webhookUrl: string,
        signingSecret: string,
        webhookHeaders?: Record<string, string>,
    ) {
        this.logger.info("Configuring webhook for dry run", { applicationId });
        const state = await this.loadStateOrEarlier(applicationId, "webhook_configuring");
        return state.configureAndDiscoverScenarios(organizationId, webhookUrl, signingSecret, webhookHeaders);
    }

    /** Execute a scenario up + down cycle. Works from discovered or any later step. */
    async runScenarioDryRun(applicationId: string, scenarioId: string) {
        this.logger.info("Running scenario dry run", { applicationId, scenarioId });
        const state = await this.loadStateOrEarlier(applicationId, "discovered");
        return state.runScenarioDryRun(scenarioId);
    }

    /** Return to `webhook_configuring` so the user can edit URL/secret. */
    async reconfigureWebhook(applicationId: string) {
        this.logger.info("Reconfiguring webhook", { applicationId });
        const state = await this.loadState(applicationId);
        await state.reconfigureWebhook();
        return this.getState(applicationId);
    }

    /** Advance from `dry_run_passed` to `github`, optionally storing a production URL. */
    async complete(applicationId: string, productionUrl?: string) {
        this.logger.info("Advancing to github step", { applicationId, hasProductionUrl: productionUrl != null });
        const state = await this.loadStateOrEarlier(applicationId, "dry_run_passed");
        await state.complete(productionUrl);
        return this.getState(applicationId);
    }

    /** Upsert the onboarding row and instantiate the matching state subclass. */
    private async loadState(applicationId: string): Promise<OnboardingState> {
        const initialOnboardingState = await this.db.onboardingState.upsert({
            where: { applicationId },
            create: { applicationId, step: INITIAL_STEP },
            select: { step: true },
            update: {},
        });
        return this.createOnboardingState(applicationId, initialOnboardingState.step);
    }

    /**
     * Load the state for an operation that should work from `minimumStep` or any later step.
     *
     * If the current step is at or past `minimumStep`, instantiates `minimumStep`'s state
     * so the operation's logic runs correctly. If the current step is before `minimumStep`,
     * instantiates the current state (which will throw InvalidOnboardingStepError as expected).
     */
    private async loadStateOrEarlier(
        applicationId: string,
        minimumStep: OnboardingState["step"],
    ): Promise<OnboardingState> {
        const row = await this.db.onboardingState.upsert({
            where: { applicationId },
            create: { applicationId, step: INITIAL_STEP },
            select: { step: true },
            update: {},
        });

        const currentIndex = STEP_ORDER.indexOf(row.step);
        const minimumIndex = STEP_ORDER.indexOf(minimumStep);

        // If we're at or past the minimum step, use the minimum step's state
        // so its operation logic runs. Otherwise, use the current state (which will reject).
        const effectiveStep = currentIndex >= minimumIndex ? minimumStep : row.step;
        this.logger.info("Loading state for backwards-compatible operation", {
            applicationId,
            currentStep: row.step,
            minimumStep,
            effectiveStep,
        });
        return this.createOnboardingState(applicationId, effectiveStep);
    }

    private createOnboardingState(applicationId: string, step: OnboardingState["step"]): OnboardingState {
        const deps: OnboardingStateDeps = {
            scenarioManager: this.scenarioManager,
            encryption: this.encryption,
        };
        const stateConstructor = OnboardingManager.states[step];
        if (stateConstructor == null) {
            throw new Error(`No state handler for step "${step}"`);
        }
        return new stateConstructor(applicationId, this.db, deps);
    }

    private async ensureApplicationHasRepository(applicationId: string, organizationId: string): Promise<void> {
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });

        if (application == null) throw new NotFoundError("Application not found");
        if (application.githubRepositoryId == null) {
            throw new ConflictError("Connect a GitHub repository before choosing a preview environment");
        }
    }

    private async ensureActivePreviewkitConfig(applicationId: string, organizationId: string): Promise<PreviewConfig> {
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: {
                activeConfigRevisionId: true,
            },
        });
        if (application == null) throw new NotFoundError("Application not found");
        if (application.activeConfigRevisionId == null) {
            throw new ConflictError("Save a valid PreviewKit config before starting a deploy");
        }

        const revision = await this.db.previewkitConfigRevision.findFirst({
            where: { id: application.activeConfigRevisionId, applicationId },
            select: { document: true },
        });
        if (revision == null) {
            throw new ConflictError("Save a valid PreviewKit config before starting a deploy");
        }

        const validation = previewConfigSchema.safeParse(revision.document);
        if (!validation.success) {
            throw new ConflictError(`Active PreviewKit config is invalid: ${z.prettifyError(validation.error)}`);
        }
        return validation.data;
    }

    private async ensureApplicationOwnsPreviewkitApp(
        applicationId: string,
        organizationId: string,
        appName: string,
    ): Promise<void> {
        const config = await this.ensureActivePreviewkitConfig(applicationId, organizationId);
        const app = config.apps.find((item) => item.name === appName);
        if (app == null) {
            throw new NotFoundError(`PreviewKit app '${appName}' is not defined in the active config`);
        }
    }

    private requirePreviewkitSecretsService(): OnboardingPreviewkitSecretsService {
        const service = this.options.previewkitSecretsService;
        if (service == null) throw new BadRequestError("PreviewKit secrets are not configured for this environment");
        return service;
    }

    private async ensureStateAtOrAfter(
        applicationId: string,
        minimumStep: OnboardingState["step"],
        action: string,
    ): Promise<void> {
        const row = await this.db.onboardingState.upsert({
            where: { applicationId },
            create: { applicationId, step: INITIAL_STEP },
            select: { step: true },
            update: {},
        });

        const currentIndex = STEP_ORDER.indexOf(row.step);
        const minimumIndex = STEP_ORDER.indexOf(minimumStep);
        if (currentIndex < minimumIndex) {
            throw new ConflictError(`Cannot ${action} during "${row.step}" step`);
        }
    }

    /**
     * Trigger the refinement loop on the application's main branch after onboarding completes.
     * The loop fires pending generations, validates them, and finalizes the snapshot.
     */
    async enqueueGenerations(applicationId: string, organizationId: string) {
        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { mainBranch: { select: { id: true, pendingSnapshotId: true } } },
        });
        const branchId = app?.mainBranch?.id;
        const pendingSnapshotId = app?.mainBranch?.pendingSnapshotId;

        if (branchId == null || pendingSnapshotId == null) {
            this.logger.info("No pending snapshot to refine after onboarding", {
                applicationId,
                branchId,
            });
            return;
        }

        try {
            this.logger.info("Triggering refinement loop after onboarding", {
                applicationId,
                branchId,
                snapshotId: pendingSnapshotId,
            });
            await triggerRefinementLoop({
                snapshotId: pendingSnapshotId,
                triggeredBy: "onboarding",
            });
            this.logger.info("Refinement loop triggered", { applicationId, branchId });
        } catch (err) {
            // Log but don't block onboarding completion - the refinement can be retried later.
            this.logger.error("Failed to trigger refinement loop after onboarding", {
                applicationId,
                branchId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
