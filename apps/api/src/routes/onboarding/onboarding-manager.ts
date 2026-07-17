import { type OnboardingPreviewEnvironmentMode, type PrismaClient } from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { SnapshotNotPendingError, TestSuiteUpdater } from "@autonoma/test-updates";
import {
    previewConfigSchema,
    validatePreviewConfigSemantics,
    type PreviewConfig,
    type PreviewkitConfigSecrets,
    type SecretItem,
} from "@autonoma/types";
import { z } from "zod";
import { isGithubNotFound, normalizeBranchName } from "../../github/git-ref";
import { computeArtifactStatus } from "../app-generations/artifact-status";
import {
    type DeploymentSignalInput,
    isCommitSha,
    parseDeploymentSignalBody,
    verifySignature,
} from "./deployment-signal";
import type { OnboardingManagerOptions, OnboardingPreviewkitSecretsService } from "./onboarding-dependencies";
import {
    type ConfigureAndDiscoverSdkTargetResult,
    OnboardingSdkCapabilityService,
    type PrepareSdkTargetResult,
} from "./onboarding-sdk-capability";
import { isStepAtOrPast } from "./onboarding-step-order";
import {
    type ListAvailableVercelProjectsResult,
    OnboardingVercelCapabilityService,
} from "./onboarding-vercel-capability";
import {
    buildExistingDeploysReadiness,
    buildPreviewkitReadiness,
    idleReadiness,
    writePreviewUrl,
    type PreviewReadiness,
} from "./preview-readiness";
import { parseStoredDependencyDocuments } from "./previewkit-config-helpers";
import {
    PreviewkitConfigService,
    type OnboardingPreviewkitConfig,
    type PreviewkitConfigValidationResult,
    type PreviewkitDependencyDocument,
} from "./previewkit-config-service";
import { listSdkDryRunTargets } from "./sdk-dry-run-targets";
import { buildSdkUrl } from "./sdk-url";
import { CompletedState } from "./states/completed-state";
import { DiffTriggerState } from "./states/diff-trigger-state";
import { ExistingDeploysConfiguringState } from "./states/existing-deploys-configuring-state";
import { ExistingDeploysWaitingState } from "./states/existing-deploys-waiting-state";
import { GitHubState } from "./states/github-state";
import type { OnboardingState, OnboardingStateDeps, ScenarioDryRunResult } from "./states/onboarding-state";
import { PreviewEnvironmentState } from "./states/preview-environment-state";
import { PreviewVerifiedState } from "./states/preview-verified-state";
import { PreviewkitConfiguringState } from "./states/previewkit-configuring-state";
import { PreviewkitDeployingState } from "./states/previewkit-deploying-state";

/**
 * Required onboarding path: "Add app" (github) is the first step now that SDK +
 * CLI work moved out into the Finish setup tab.
 */
const INITIAL_STEP: OnboardingState["step"] = "github";

/**
 * Facade for the onboarding state machine.
 *
 * Every public method loads the current {@link OnboardingState} subclass from the
 * database and delegates the operation to it. This keeps the manager thin while
 * the state subclasses enforce which transitions are valid at each step.
 *
 * For backwards-compatible operations (e.g. completing github again from a later
 * step), the manager loads the state that implements the operation instead of
 * the current state. This allows users to go back and redo earlier steps without
 * the state machine rejecting them.
 *
 * Flow: github (Add app) -> preview_environment ->
 * (previewkit_configuring | existing_deploys_*) -> preview_verified ->
 * diff_trigger -> completed. SDK implement + dry-run are app-level capabilities
 * outside this flow. Reset is available from any step.
 */
export class OnboardingManager {
    private readonly logger: Logger;
    private readonly previewkitConfig: PreviewkitConfigService;
    private readonly sdkCapability: OnboardingSdkCapabilityService;
    private readonly vercelCapability: OnboardingVercelCapabilityService;

    private static readonly states: Partial<
        Record<
            OnboardingState["step"],
            new (applicationId: string, db: PrismaClient, deps: OnboardingStateDeps) => OnboardingState
        >
    > = {
        github: GitHubState,
        preview_environment: PreviewEnvironmentState,
        previewkit_configuring: PreviewkitConfiguringState,
        previewkit_deploying: PreviewkitDeployingState,
        existing_deploys_configuring: ExistingDeploysConfiguringState,
        existing_deploys_waiting: ExistingDeploysWaitingState,
        preview_verified: PreviewVerifiedState,
        diff_trigger: DiffTriggerState,
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
        this.sdkCapability = new OnboardingSdkCapabilityService(db, scenarioManager, encryption, options);
        this.vercelCapability = new OnboardingVercelCapabilityService(db, options);
    }

    async getState(applicationId: string) {
        this.logger.info("Getting onboarding state", { applicationId });

        const row = await this.db.$transaction(async (tx) => {
            // Read-first: getState is polled, so avoid a write on every call.
            // Only create the row the first time, and only update when recovering
            // a stuck discovery.
            let current = await tx.onboardingState.findUnique({ where: { applicationId } });
            if (current == null) {
                current = await tx.onboardingState.create({
                    data: { applicationId, step: INITIAL_STEP },
                });
            }

            if (OnboardingSdkCapabilityService.isDiscoveryStuck(current.discoveringStartedAt)) {
                this.logger.warn("Recovering stuck discover capability", {
                    applicationId,
                    discoveringStartedAt: current.discoveringStartedAt,
                });
                current = await tx.onboardingState.update({
                    where: { applicationId },
                    data: {
                        discoveringStartedAt: null,
                        lastDiscoveryError: "Discovery timed out or crashed. Please retry.",
                    },
                });
            }

            return current;
        });

        const sdkConfigured = row.lastDiscoveredAt != null;
        const dryRunPassed = row.dryRunPassedAt != null;
        const discoveryInProgress = row.discoveringStartedAt != null;

        // `stepComplete` (computed once, server-side) is the gate: the run completed
        // AND every artifact - recipe included - landed. A run can finish uploading
        // tests/kb/scenarios while the recipe submit silently fails (missing factory,
        // rejected upload); without this the user advances to the SDK step and lands
        // on a dry-run with no scenarios to run.
        const { stepComplete: artifactsUploaded } = await computeArtifactStatus(this.db, applicationId);

        // `hasContent` only needs existence, so probe with `findFirst` (take: 1)
        // rather than two full `count`s on every poll.
        const [scenario, testCase] = await Promise.all([
            this.db.scenario.findFirst({ where: { applicationId }, select: { id: true } }),
            // Ignore investigation shadow cases - they are validation probes, not real onboarding content.
            this.db.testCase.findFirst({ where: { applicationId, shadow: false }, select: { id: true } }),
        ]);
        const hasContent = scenario != null && testCase != null;

        const setupComplete = (sdkConfigured && dryRunPassed && artifactsUploaded) || hasContent;

        return {
            ...row,
            sdkConfigured,
            dryRunPassed,
            discoveryInProgress,
            artifactsUploaded,
            hasContent,
            setupComplete,
        };
    }

    /** Return the agent log entries for the application. */
    async getLogs(applicationId: string) {
        const row = await this.db.onboardingState.findUnique({
            where: { applicationId },
            select: { agentLogs: true },
        });

        return { logs: row?.agentLogs ?? [] };
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
        dependencyDocuments: PreviewkitDependencyDocument[] = [],
        secrets: PreviewkitConfigSecrets = [],
    ): Promise<OnboardingPreviewkitConfig> {
        this.logger.info("Saving onboarding PreviewKit config", {
            applicationId,
            organizationId,
            secretApps: secrets.length,
        });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        await this.ensureStateAtOrAfter(applicationId, "previewkit_configuring", "save PreviewKit config");
        await this.assertSecretPathsAvailable(applicationId, organizationId, document, dependencyDocuments);

        // AWS-first: upsert secrets before committing the config. If a
        // secret write throws, the config never saves, so the two stores stay
        // consistent (the rare residual - secrets written, config not - is the
        // safe direction: extra secret values are harmless until referenced).
        await this.upsertConfigSecrets(applicationId, organizationId, document, secrets);

        const saved = await this.previewkitConfig.save(applicationId, organizationId, document, dependencyDocuments);

        // Deletes run after the commit so a rolled-back config can never end up
        // referencing a secret we already removed. Best-effort: a leftover secret
        // is harmless, so we log and continue rather than fail the saved config.
        await this.deleteConfigSecrets(applicationId, organizationId, secrets);

        await this.sdkCapability.ensureManagedSharedSecretForConfig(applicationId, organizationId, saved.document);

        return saved;
    }

    /**
     * Save-time collision preflight: every app name in the primary + dependency
     * documents must map to a secret path that is unowned or ours. Names are
     * lossy-sanitized into `previewkit/<org>/<application>/<app>`, so a foreign
     * collision would otherwise only surface mid-deploy as an adoption refusal
     * ("Refusing to adopt AWS secret ..."). Documents that fail shape-parsing are
     * skipped here - the config save right after rejects them with the real error.
     */
    private async assertSecretPathsAvailable(
        applicationId: string,
        organizationId: string,
        document: unknown,
        dependencyDocuments: PreviewkitDependencyDocument[],
    ): Promise<void> {
        const secretsService = this.options.previewkitSecretsService;
        if (secretsService?.assertSecretPathsAvailable == null) return;

        const documents = [document, ...dependencyDocuments.map((dependency) => dependency.document)];
        const appNames = documents.flatMap((entry) => {
            const parsed = previewConfigSchema.safeParse(entry);
            return parsed.success ? parsed.data.apps.map((app) => app.name) : [];
        });
        if (appNames.length === 0) return;

        await secretsService.assertSecretPathsAvailable(applicationId, [...new Set(appNames)], organizationId);
    }

    /** Validate secret app names against the document being saved, then upsert (AWS) before the DB commit. */
    private async upsertConfigSecrets(
        applicationId: string,
        organizationId: string,
        document: unknown,
        secrets: PreviewkitConfigSecrets,
    ): Promise<void> {
        const withUpserts = secrets.filter((entry) => entry.upserts.length > 0);
        const withDeletes = secrets.filter((entry) => entry.deletes.length > 0);
        if (withUpserts.length === 0 && withDeletes.length === 0) return;

        const parsed = previewConfigSchema.safeParse(document);
        if (!parsed.success) {
            throw new BadRequestError("Cannot save secrets: the PreviewKit config is invalid");
        }
        const appNames = new Set(parsed.data.apps.map((app) => app.name));
        for (const entry of secrets) {
            if (!appNames.has(entry.appName)) {
                throw new NotFoundError(`PreviewKit app '${entry.appName}' is not defined in the config`);
            }
        }

        const secretsService = this.requirePreviewkitSecretsService();
        for (const entry of withUpserts) {
            this.logger.info("Upserting config secrets", {
                applicationId,
                appName: entry.appName,
                count: entry.upserts.length,
            });
            await secretsService.upsert(applicationId, entry.appName, entry.upserts, organizationId);
        }
    }

    /** Best-effort delete of removed secret keys after the config has committed. */
    private async deleteConfigSecrets(
        applicationId: string,
        organizationId: string,
        secrets: PreviewkitConfigSecrets,
    ): Promise<void> {
        const withDeletes = secrets.filter((entry) => entry.deletes.length > 0);
        if (withDeletes.length === 0) return;

        const secretsService = this.requirePreviewkitSecretsService();
        for (const entry of withDeletes) {
            for (const key of entry.deletes) {
                try {
                    await secretsService.delete(applicationId, entry.appName, key, organizationId);
                } catch (err) {
                    this.logger.warn("Failed to delete a removed config secret (left in place)", {
                        applicationId,
                        appName: entry.appName,
                        key,
                        err,
                    });
                }
            }
        }
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

    async listDockerfiles(applicationId: string, organizationId: string, githubRepositoryId?: number) {
        this.logger.info("Listing repo Dockerfiles for PreviewKit config editor", {
            applicationId,
            organizationId,
            githubRepositoryId,
        });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        return this.previewkitConfig.listDockerfiles(applicationId, organizationId, githubRepositoryId);
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
        this.logger.info("Triggering PreviewKit base preview (environment 0) onboarding deploy", {
            applicationId,
            organizationId,
        });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        await this.ensureStateAtOrAfter(applicationId, "previewkit_configuring", "trigger PreviewKit deploy");

        const previewkitClient = this.options.previewkitClient;
        if (previewkitClient == null || !previewkitClient.isConfigured()) {
            throw new BadRequestError("PreviewKit is not configured for this environment");
        }

        const savedConfig = await this.ensureSavedPreviewkitConfig(applicationId, organizationId);
        const blockingIssues = validatePreviewConfigSemantics(savedConfig).filter(
            (issue) => issue.severity === "error",
        );
        if (blockingIssues.length > 0) {
            const issueText = blockingIssues
                .map((issue) => {
                    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
                    return `${path}${issue.message}`;
                })
                .join("; ");
            throw new ConflictError(`Saved PreviewKit config has blocking issues: ${issueText}`);
        }

        await previewkitClient.deployApplicationMain(applicationId, organizationId);

        await this.db.onboardingState.update({
            where: { applicationId },
            data: {
                step: "previewkit_deploying",
                previewEnvironmentMode: "previewkit",
                previewVerificationStatus: "building",
                previewDeployRequestedAt: new Date(),
            },
        });

        return this.getPreviewReadiness(applicationId, organizationId);
    }

    /**
     * Sets the branch the base preview (environment 0) deploys from - the app's
     * stored deploy ref, which {@link deployMainBranch} resolves at deploy time.
     * Defaults to the repo's default branch; this is how a coding agent or the UI
     * overrides it. Persisting the branch is deliberately separate from triggering a
     * deploy, so the branch can be picked without deploying yet. The branch is
     * validated against GitHub (a 404 means it doesn't exist) so a typo can't
     * silently break the deploy.
     */
    async setDeployBranch(applicationId: string, organizationId: string, branch: string): Promise<{ branch: string }> {
        this.logger.info("Setting PreviewKit deploy branch", { applicationId, organizationId, extra: { branch } });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        await this.ensureStateAtOrAfter(applicationId, "previewkit_configuring", "set deploy branch");

        const normalized = normalizeBranchName(branch);
        if (normalized === "") throw new BadRequestError("Branch name is required");

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true, mainBranchId: true },
        });
        // The deploy branch is stored on the app's main-branch record (the base
        // environment, distinct from the git default branch it tracks); its absence
        // is a structural data error - every application is created with one.
        if (application?.mainBranchId == null) throw new NotFoundError("Application has no main branch record");

        const github = this.options.github;
        if (github != null && application.githubRepositoryId != null) {
            try {
                await github.getBranchHead(organizationId, application.githubRepositoryId, normalized);
            } catch (err) {
                if (isGithubNotFound(err)) {
                    throw new BadRequestError(`Branch '${normalized}' not found on GitHub`);
                }
                // A transient GitHub failure shouldn't block choosing a branch; the
                // deploy re-resolves the ref and reports a genuine miss then.
                this.logger.warn("Could not verify deploy branch on GitHub; saving anyway", { applicationId, err });
            }
        }

        await this.db.$transaction([
            this.db.branch.update({ where: { id: application.mainBranchId }, data: { name: normalized } }),
            this.db.mainBranchInfo.updateMany({
                where: { branchId: application.mainBranchId },
                data: { githubRef: normalized },
            }),
        ]);

        return { branch: normalized };
    }

    /**
     * The branch options for the deploy-branch picker: the repo's branches with
     * the repo default first, the currently-selected branch always present (even
     * if it fell off the listed page), and the default flagged. `truncated` tells
     * the UI the repo has more branches than the one page returned, so it can offer
     * free-text entry for a branch that isn't listed.
     */
    async listDeployBranchOptions(
        applicationId: string,
        organizationId: string,
    ): Promise<{ branches: string[]; defaultBranch?: string; currentBranch?: string; truncated: boolean }> {
        this.logger.info("Listing deploy branch options", { applicationId, organizationId });
        await this.ensureApplicationHasRepository(applicationId, organizationId);

        const github = this.options.github;
        const [application, listed] = await Promise.all([
            this.db.application.findFirst({
                where: { id: applicationId, organizationId },
                select: { mainBranch: { select: { name: true } } },
            }),
            github?.listApplicationBranches(organizationId, applicationId).catch((err: unknown) => {
                this.logger.warn("Failed to list branches from GitHub; deploy-branch picker falls back to free text", {
                    applicationId,
                    err,
                });
                return undefined;
            }),
        ]);

        const currentBranch = application?.mainBranch?.name ?? undefined;
        const defaultBranch = listed?.defaultBranch;

        // Default first, then the current selection (if it isn't the default and
        // isn't already listed), then the rest - deduped so a branch never repeats.
        const ordered: string[] = [];
        const seen = new Set<string>();
        const add = (name: string | undefined) => {
            if (name == null || name === "" || seen.has(name)) return;
            seen.add(name);
            ordered.push(name);
        };
        add(defaultBranch);
        add(currentBranch);
        for (const name of listed?.names ?? []) add(name);

        return { branches: ordered, defaultBranch, currentBranch, truncated: listed?.truncated ?? false };
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
            // The deploy-request time, NOT the row's `updatedAt`: the latter is bumped
            // by unrelated writes (the agent heartbeat) and would drift past the moment
            // the environment goes ready, so the deploy would never be observed as ready.
            // Fall back to `updatedAt` only for rows predating this column.
            state.previewDeployRequestedAt ?? state.updatedAt,
        );
    }

    /** Verify the preview is ready and advance `preview_verified` -> `diff_trigger`. */
    async completePreviewOnboarding(applicationId: string, organizationId: string) {
        this.logger.info("Completing preview onboarding", { applicationId, organizationId });
        const readiness = await this.getPreviewReadiness(applicationId, organizationId);
        if (readiness.diagnostics.status !== "ready") {
            throw new ConflictError("Preview environment is not ready yet");
        }

        const state = await this.loadStateOrEarlier(applicationId, "preview_verified");
        await state.completePreviewOnboarding();
        return this.getState(applicationId);
    }

    /**
     * Go live: advance `diff_trigger` -> `completed` and activate the main-branch
     * pending snapshot. For BYO this is optimistic - the first real PR
     * `deployment_status` self-confirms via `diffTriggerConfirmedAt`.
     */
    async goLive(applicationId: string, organizationId: string) {
        this.logger.info("Going live", { applicationId, organizationId });
        const state = await this.loadStateOrEarlier(applicationId, "diff_trigger");
        await state.goLive();
        await this.activatePendingSnapshot(applicationId, organizationId);
        this.reinvestigateDroppedPrComments(applicationId, organizationId);
        return this.getState(applicationId);
    }

    /**
     * Fire-and-forget recovery for the onboarding race: a PR investigation that finished while the app was
     * still onboarding had its comment suppressed by the onboarding gate. Now that the app is live, re-run
     * those investigations so the comments post. Contained and detached so it never adds latency to, or fails,
     * the go-live transition. Idempotent (only comment-less open PRs are targeted), so a double call is safe.
     */
    reinvestigateDroppedPrComments(applicationId: string, organizationId: string): void {
        void this.options.diffsTrigger?.reinvestigateOpenPrs(applicationId, organizationId).catch((err) => {
            this.logger.error("Failed to reinvestigate open PRs after go-live", { applicationId, err });
        });
    }

    async acceptDeploymentSignal(input: DeploymentSignalInput) {
        this.logger.info("Accepting onboarding deployment signal");
        const body = parseDeploymentSignalBody(input.bodyText);
        const application = await this.db.application.findUnique({
            where: { id: body.applicationId },
            select: {
                id: true,
                organizationId: true,
                githubRepositoryId: true,
                signingSecretEnc: true,
                mainBranch: { select: { deploymentId: true, name: true } },
                onboardingState: { select: { previewEnvironmentMode: true, step: true, diffTriggerConfirmedAt: true } },
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

        const mainBranchName = application.mainBranch?.name;
        const branchIsProviderCommitRef = body.branch != null && isCommitSha(body.branch);
        const isNonMainBranch =
            body.branch != null &&
            mainBranchName != null &&
            body.branch !== mainBranchName &&
            !branchIsProviderCommitRef;

        if (body.prNumber != null && isNonMainBranch) {
            const triggered = await this.triggerDiffsFromSignal(application.id, application.organizationId, {
                repoId: application.githubRepositoryId ?? undefined,
                prNumber: body.prNumber,
                previewUrl: body.previewUrl,
            });
            if (triggered && application.onboardingState.diffTriggerConfirmedAt == null) {
                await this.db.onboardingState.update({
                    where: { applicationId: application.id },
                    data: { diffTriggerConfirmedAt: new Date() },
                });
            }
            return { ok: true, applicationId: application.id, previewUrl: body.previewUrl, ignored: false };
        }

        if (isNonMainBranch) {
            this.logger.info("Ignoring deployment signal for non-main branch with no PR number", {
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
        if (application.onboardingState.step === "completed") {
            await this.triggerDiffsFromSignal(application.id, application.organizationId, {
                repoId: application.githubRepositoryId ?? undefined,
                previewUrl: body.previewUrl,
            });
        }

        return { ok: true, applicationId: application.id, previewUrl: body.previewUrl, ignored: false };
    }

    /**
     * Fan a deployment signal out to diff analysis using the preview URL it
     * carries. Best-effort: a diff-trigger failure must not fail the signal (the
     * URL is already recorded). Returns whether a diff job was triggered.
     */
    private async triggerDiffsFromSignal(
        applicationId: string,
        organizationId: string,
        params: { repoId?: number; prNumber?: number; previewUrl: string },
    ): Promise<boolean> {
        const diffsTrigger = this.options.diffsTrigger;
        if (diffsTrigger == null || params.repoId == null) {
            this.logger.info("Skipping diff trigger from signal (no diffs trigger or repo)", {
                applicationId,
                hasDiffsTrigger: diffsTrigger != null,
                hasRepo: params.repoId != null,
            });
            return false;
        }

        const webhookUrl = buildSdkUrl(params.previewUrl);
        try {
            if (params.prNumber != null) {
                await diffsTrigger.triggerPrDiffs({
                    organizationId,
                    repoId: params.repoId,
                    prNumber: params.prNumber,
                    url: params.previewUrl,
                    webhookUrl,
                });
            } else {
                await diffsTrigger.triggerMainDiffs({
                    organizationId,
                    repoId: params.repoId,
                    url: params.previewUrl,
                    webhookUrl,
                });
            }
            this.logger.info("Triggered diff analysis from deployment signal", {
                applicationId,
                prNumber: params.prNumber,
            });
            return true;
        } catch (err) {
            this.logger.error("Failed to trigger diff analysis from deployment signal", {
                applicationId,
                prNumber: params.prNumber,
                error: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
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

    /**
     * SDK capability: validate the customer's environment-factory endpoint via
     * discover and persist it. Tracked outside the linear `step` (run from the
     * Finish setup tab), so it never advances onboarding.
     */
    async configureAndDiscoverScenarios(
        applicationId: string,
        organizationId: string,
        webhookUrl: string,
        signingSecret: string,
        webhookHeaders?: Record<string, string>,
    ): Promise<OnboardingStateView> {
        this.logger.info("Configuring SDK endpoint and discovering scenarios", { applicationId });
        await this.sdkCapability.configureAndDiscover(
            applicationId,
            organizationId,
            webhookUrl,
            signingSecret,
            webhookHeaders,
        );
        return this.getState(applicationId);
    }

    async listAvailableVercelProjects(
        applicationId: string,
        organizationId: string,
    ): Promise<ListAvailableVercelProjectsResult> {
        return this.vercelCapability.listAvailableVercelProjects(applicationId, organizationId);
    }

    async linkVercelProject(
        applicationId: string,
        organizationId: string,
        vercelProjectId: string,
    ): Promise<OnboardingStateView> {
        this.logger.info("Linking Vercel project", { applicationId, vercelProjectId });
        await this.vercelCapability.linkVercelProject(applicationId, organizationId, vercelProjectId);
        return this.getState(applicationId);
    }

    async unlinkVercelProject(applicationId: string, organizationId: string): Promise<OnboardingStateView> {
        this.logger.info("Unlinking Vercel project", { applicationId });
        await this.vercelCapability.unlinkVercelProject(applicationId, organizationId);
        return this.getState(applicationId);
    }

    async prepareSdkTarget(
        applicationId: string,
        organizationId: string,
        targetId: string,
    ): Promise<PrepareSdkTargetResult> {
        this.logger.info("Preparing managed SDK target", { applicationId, targetId });
        return this.sdkCapability.prepareManagedTarget(applicationId, organizationId, targetId);
    }

    async configureAndDiscoverSdkTarget(
        applicationId: string,
        organizationId: string,
        targetId: string,
        allowSelfHeal: boolean,
    ): Promise<ConfigureAndDiscoverSdkTargetResult> {
        this.logger.info("Configuring managed SDK target and discovering scenarios", { applicationId, targetId });
        return this.sdkCapability.configureAndDiscoverTarget(applicationId, organizationId, targetId, allowSelfHeal);
    }

    /**
     * SDK capability: execute a scenario up + down cycle. Records `dryRunPassedAt`
     * on success. When `targetId` is given, the dry run is pointed at that preview
     * env (the auto-detected SDK PR or main); otherwise it reuses the last
     * configured endpoint.
     */
    async runScenarioDryRun(
        applicationId: string,
        organizationId: string,
        scenarioId: string,
        targetId?: string,
    ): Promise<ScenarioDryRunResult> {
        this.logger.info("Running scenario dry run", { applicationId, scenarioId, extra: { targetId } });
        return this.sdkCapability.runDryRun(applicationId, organizationId, scenarioId, targetId);
    }

    /**
     * SDK capability: list the preview envs the dry-run can target (open-PR
     * previews + main), flagging the auto-detected SDK implementation PR.
     */
    async listSdkDryRunTargets(applicationId: string, organizationId: string) {
        this.logger.info("Listing SDK dry-run targets", { applicationId, organizationId });
        return listSdkDryRunTargets(this.db, applicationId, organizationId);
    }

    /**
     * SDK capability: user-triggered (re)deploy of a dry-run target's preview -
     * an existing env redeploys at the latest head/config, a PR without one
     * gets its first deploy.
     */
    async redeploySdkDryRunTarget(applicationId: string, organizationId: string, targetId: string): Promise<void> {
        this.logger.info("Redeploying SDK dry-run target", { applicationId, organizationId, extra: { targetId } });
        return this.sdkCapability.redeployDryRunTarget(applicationId, organizationId, targetId);
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

        // If we're at or past the minimum step, use the minimum step's state
        // so its operation logic runs. Otherwise, use the current state (which will reject).
        const effectiveStep = isStepAtOrPast(row.step, minimumStep) ? minimumStep : row.step;
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

    private async ensureSavedPreviewkitConfig(applicationId: string, organizationId: string): Promise<PreviewConfig> {
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: {
                previewkitConfig: { select: { document: true } },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");
        if (application.previewkitConfig == null) {
            throw new ConflictError("Save a valid PreviewKit config before starting a deploy");
        }

        const validation = previewConfigSchema.safeParse(application.previewkitConfig.document);
        if (!validation.success) {
            throw new ConflictError(`Saved PreviewKit config is invalid: ${z.prettifyError(validation.error)}`);
        }
        return validation.data;
    }

    private async ensureApplicationOwnsPreviewkitApp(
        applicationId: string,
        organizationId: string,
        appName: string,
    ): Promise<void> {
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: {
                previewkitConfig: { select: { document: true, dependencyDocuments: true } },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");
        const stored = application.previewkitConfig;
        if (stored == null) {
            throw new ConflictError("Save a valid PreviewKit config before managing secrets");
        }

        const primary = previewConfigSchema.safeParse(stored.document);
        if (!primary.success) {
            throw new ConflictError(`Saved PreviewKit config is invalid: ${z.prettifyError(primary.error)}`);
        }

        const { documents } = parseStoredDependencyDocuments(stored.dependencyDocuments);
        const appNames = new Set([
            ...primary.data.apps.map((app) => app.name),
            ...documents.flatMap((dependency) => dependency.document.apps.map((app) => app.name)),
        ]);
        if (!appNames.has(appName)) {
            throw new NotFoundError(`PreviewKit app '${appName}' is not defined in the saved config`);
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

        if (!isStepAtOrPast(row.step, minimumStep)) {
            throw new ConflictError(`Cannot ${action} during "${row.step}" step`);
        }
    }

    /**
     * Activate the application's main-branch pending snapshot after onboarding
     * completes. Onboarding no longer pre-computes generations, so the uploaded
     * tests' generation jobs are never run - they generate later when a PR
     * triggers them. `discardPendingGenerations` drops those still-`pending` jobs
     * so finalization isn't blocked by `IncompleteGenerationsError`.
     */
    async activatePendingSnapshot(applicationId: string, organizationId: string) {
        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { mainBranch: { select: { id: true, pendingSnapshotId: true } } },
        });
        const branchId = app?.mainBranch?.id;
        const pendingSnapshotId = app?.mainBranch?.pendingSnapshotId;

        if (branchId == null || pendingSnapshotId == null) {
            this.logger.info("No pending snapshot to activate after onboarding", {
                applicationId,
                branchId,
            });
            return;
        }

        try {
            this.logger.info("Activating pending snapshot after onboarding", {
                applicationId,
                branchId,
                snapshotId: pendingSnapshotId,
            });
            const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
                db: this.db,
                snapshotId: pendingSnapshotId,
                organizationId,
            });
            await updater.finalize({ discardPendingGenerations: true });
            this.logger.info("Pending snapshot activated", { applicationId, branchId });
        } catch (err) {
            if (err instanceof SnapshotNotPendingError) {
                // Benign: a concurrent/duplicate signal already activated this
                // snapshot (go-live + a later setup-completion both target it).
                this.logger.info("Pending snapshot already activated - skipping", {
                    applicationId,
                    branchId,
                    snapshotId: pendingSnapshotId,
                });
                return;
            }
            // Log but don't block onboarding completion. The snapshot stays
            // pending; a later setup-completion signal re-attempts activation via
            // activateSnapshotAfterSetupCompletion.
            this.logger.error("Failed to activate pending snapshot after onboarding", {
                applicationId,
                branchId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/**
 * The resolved onboarding state returned by `getState`: the persisted row plus
 * the derived flags (`sdkConfigured`, `setupComplete`, ...). `Awaited<...>`
 * unwraps the promise so callers annotate a flat value, not `Promise<Promise<T>>`.
 */
export type OnboardingStateView = Awaited<ReturnType<OnboardingManager["getState"]>>;
