import {
    type OnboardingPreviewEnvironmentMode,
    type OnboardingState as OnboardingStateRow,
    type OnboardingStep,
    previewkitConfigRowsInclude,
    type PrismaClient,
} from "@autonoma/db";
import { BadRequestError, ConflictError, NotFoundError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { SnapshotNotFoundError, SnapshotNotOpenError, TestSuiteStore } from "@autonoma/test-suite";
import {
    buildSdkUrl,
    documentFromPreviewkitConfigRows,
    previewConfigSchema,
    validatePreviewConfigSemantics,
    type PreviewConfig,
    type PreviewkitConfigSecrets,
    type SecretItem,
} from "@autonoma/types";
import { hasGoneLive } from "@autonoma/types";
import { z } from "zod";
import { applicationBranchRefs } from "../../github/application-branch-refs";
import { isGithubNotFound, normalizeBranchName } from "../../github/git-ref";
import { assertApplicationInOrg } from "./assert-application-in-org";
import {
    type DeploymentSignalInput,
    isCommitSha,
    parseDeploymentSignalBody,
    verifySignature,
} from "./deployment-signal";
import { describeUnfinishedStep, describeUnverifiedPreview } from "./go-live-guidance";
import { OnboardingAnalytics, type DeploymentSignalEvent, type OnboardingActor } from "./onboarding-analytics";
import type { OnboardingManagerOptions, OnboardingPreviewkitSecretsService } from "./onboarding-dependencies";
import {
    type ConfigureAndDiscoverSdkTargetResult,
    OnboardingSdkCapabilityService,
    type PrepareSdkTargetResult,
    type ScenarioDryRunRequest,
    isSharedSecretDrift401,
} from "./onboarding-sdk-capability";
import { isStepAtOrPast } from "./onboarding-step-order";
import {
    type ListAvailableVercelProjectsResult,
    OnboardingVercelCapabilityService,
    type VercelDeploymentStatusResult,
    type VercelRedeployResult,
} from "./onboarding-vercel-capability";
import {
    buildExistingDeploysReadiness,
    buildPreviewkitReadiness,
    idleReadiness,
    writePreviewUrl,
    type PreviewReadiness,
} from "./preview-readiness";
import { parseAuthoredConfigShapeOrThrow } from "./previewkit-config-helpers";
import {
    PreviewkitConfigService,
    type OnboardingPreviewkitConfig,
    type PreviewkitConfigValidationResult,
} from "./previewkit-config-service";
import { computeSetupState } from "./setup-state";
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

/** Reported for a discovery whose worker died mid-run, in place of the stored error. */
const DISCOVERY_TIMED_OUT_ERROR = "Discovery timed out or crashed. Please retry.";

/**
 * Identity of the synthesised state returned for an application with no onboarding row. No row means
 * no id and no timestamps; these stand in for them, and are stable so a poll does not see them move.
 */
const BLANK_STATE_ID = "";
const BLANK_STATE_TIMESTAMP = new Date(0);

/**
 * Result of validating a Vercel deployment SDK target: discovered + persisted,
 * or a secret-drift 401 kicked off a self-healing redeploy whose new deployment
 * id the caller polls + retries once ready.
 */
export type DiscoverVercelDeploymentTargetResult =
    | { status: "discovered" }
    | { status: "redeploy_started"; deploymentId: string };

/**
 * What taking an app live did, for a caller that has to report it.
 *
 * `transitions` is empty when the app was already live, which is the same thing
 * `alreadyLive` says - kept separate because a caller usually renders one and logs
 * the other.
 */
export interface TakeLiveResult {
    step: OnboardingStep;
    /** True when the call changed nothing because the app was live already. */
    alreadyLive: boolean;
    /** The step changes this call made, in order, for an activity feed or a log. */
    transitions: string[];
    /** The onboarding state as it stands now. */
    state: Awaited<ReturnType<OnboardingManager["getState"]>>;
}

/** The application an accepted deployment signal is reported against. */
interface SignalledApplication {
    id: string;
    organizationId: string;
}

/** Its onboarding row, as far as analytics needs it. */
interface SignalledOnboardingState {
    step: OnboardingStep;
    previewEnvironmentMode: OnboardingPreviewEnvironmentMode | null;
}

/**
 * The analytics identity for work with no acting user - the customer's CI called
 * it, not a person - so the organization stands in as the distinct id.
 */
function machineActor(application: SignalledApplication): OnboardingActor {
    return {
        distinctId: application.organizationId,
        organizationId: application.organizationId,
        applicationId: application.id,
    };
}

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
    private readonly analytics: OnboardingAnalytics;
    private readonly suite: TestSuiteStore;

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
        this.suite = new TestSuiteStore(db);
        this.previewkitConfig = new PreviewkitConfigService(db, options);
        this.analytics = new OnboardingAnalytics(db);
        this.vercelCapability = new OnboardingVercelCapabilityService(db, options);
        this.sdkCapability = new OnboardingSdkCapabilityService(
            db,
            scenarioManager,
            encryption,
            this.vercelCapability,
            this.analytics,
            options,
        );
    }

    /**
     * Whether the Finish setup nav entry should be offered, and nothing else.
     *
     * The app shell renders on every page, and `getState` answers with this app's preview and
     * production URLs, its discovery error and its live pairing code to decide one boolean. This
     * reads the gate on its own.
     */
    async getNavState(applicationId: string): Promise<{ setupComplete: boolean }> {
        this.logger.info("Getting onboarding nav state", { application: { applicationId } });

        const { setupComplete } = await computeSetupState(this.db, applicationId, this.logger);
        return { setupComplete };
    }

    async getState(applicationId: string) {
        this.logger.info("Getting onboarding state", { application: { applicationId } });

        const [row, setupState] = await Promise.all([
            this.db.onboardingState.findUnique({ where: { applicationId } }),
            computeSetupState(this.db, applicationId, this.logger),
        ]);

        // A query must not write, so an application whose row predates eager creation answers with
        // the state a new one would have rather than being given a row here. Every onboarding
        // mutation upserts, so it materialises on the first write instead.
        const state = row ?? this.blankState(applicationId);

        // Derived, not repaired: a discovery whose worker died leaves `discoveringStartedAt` set
        // forever, and the screen has to stop claiming it is still running. The retry mutation is
        // what actually overwrites the timestamp and clears the error.
        const discoveryStuck = OnboardingSdkCapabilityService.isDiscoveryStuck(state.discoveringStartedAt);
        if (discoveryStuck) {
            this.logger.warn("Discovery timed out, reporting it as stopped", {
                application: { applicationId },
                extra: { discoveringStartedAt: state.discoveringStartedAt },
            });
        }

        return {
            ...state,
            discoveringStartedAt: discoveryStuck ? null : state.discoveringStartedAt,
            lastDiscoveryError: discoveryStuck ? DISCOVERY_TIMED_OUT_ERROR : state.lastDiscoveryError,
            discoveryInProgress: !discoveryStuck && state.discoveringStartedAt != null,
            sdkConfigured: setupState.sdkConfigured,
            dryRunPassed: setupState.dryRunPassed,
            artifactsUploaded: setupState.artifactsUploaded,
            hasContent: setupState.hasContent,
            setupComplete: setupState.setupComplete,
        };
    }

    /**
     * The state an application has before anything has been recorded against it, mirroring the
     * schema's own column defaults. For rows that predate eager creation at application creation;
     * never persisted - see {@link getState}.
     *
     * The identity and timestamp fields are stable placeholders rather than `new Date()` because
     * `getState` is polled: a moving `updatedAt` would hand React Query a changed object on every
     * tick and re-render the screen for an application nothing has happened to.
     */
    private blankState(applicationId: string): OnboardingStateRow {
        return {
            id: BLANK_STATE_ID,
            applicationId,
            step: INITIAL_STEP,
            agentConnectedAt: null,
            agentLogs: [],
            productionUrl: null,
            previewEnvironmentMode: null,
            previewUrl: null,
            previewVerificationStatus: "idle",
            previewVerificationError: null,
            previewDeployRequestedAt: null,
            completedAt: null,
            lastDiscoveryError: null,
            lastDiscoveredAt: null,
            lastDiscoveredModels: null,
            discoveringStartedAt: null,
            dryRunPassedAt: null,
            diffTriggerConfirmedAt: null,
            agentHolder: "human",
            agentLastActivityAt: null,
            agentPendingRequest: null,
            agentPairingCode: null,
            agentPairingExpiresAt: null,
            agentClient: null,
            createdAt: BLANK_STATE_TIMESTAMP,
            updatedAt: BLANK_STATE_TIMESTAMP,
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

        // Selecting a path resets the step and clears the preview URL, so it is
        // destructive to any progress already made on the current one. Re-picking the
        // same path is therefore a no-op rather than a restart - an agent that calls
        // this twice should not lose a preview - and switching away is refused once
        // the preview is verified, because that discards a finished setup.
        const current = await this.db.onboardingState.findUnique({
            where: { applicationId },
            select: { step: true, previewEnvironmentMode: true },
        });
        if (current?.previewEnvironmentMode === mode) return this.getState(applicationId);
        if (
            current != null &&
            current.previewEnvironmentMode != null &&
            isStepAtOrPast(current.step, "preview_verified")
        ) {
            throw new ConflictError(
                "This app already has a verified preview on its current path, and switching would discard it. " +
                    "Change the preview source in the Autonoma UI if that is really what the user wants.",
            );
        }

        const state = await this.loadStateOrEarlier(applicationId, "preview_environment");
        await state.selectPreviewEnvironmentMode(mode);
        return this.getState(applicationId);
    }

    /**
     * Existing-deploys path: advance from `existing_deploys_configuring` to
     * `existing_deploys_waiting`. Uses the actual current state (not an earlier
     * one) so a signal that already advanced the row to `preview_verified` is
     * never rolled back; the waiting state treats the call as idempotent.
     *
     * Requires a signal to have actually landed. This path builds nothing and
     * keeps no logs, so confirming wiring we have never seen work moves onboarding
     * forward over a setup that may be silently broken with nothing to diagnose it
     * from. The preview URL only exists because a signal delivered it, which is the
     * same thing the UI's own confirm button waits for.
     */
    async confirmExistingDeploysSetup(applicationId: string, organizationId: string) {
        this.logger.info("Confirming existing-deploys setup", { applicationId });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        const signal = await this.db.onboardingState.findUnique({
            where: { applicationId },
            select: { previewUrl: true },
        });
        if (signal?.previewUrl == null) {
            throw new ConflictError(
                "No deployment signal has reached Autonoma yet, so there is nothing to confirm. Run a deploy " +
                    "through the pipeline and wait for the signal to land - if it never does, the wiring is wrong " +
                    "and confirming here would only hide that.",
            );
        }
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
        secrets: PreviewkitConfigSecrets = [],
    ): Promise<OnboardingPreviewkitConfig> {
        this.logger.info("Saving onboarding PreviewKit config", {
            applicationId,
            organizationId,
            secretApps: secrets.length,
        });
        // Onboarding never writes a build the config editor cannot render, so a
        // retired framework preset is rejected here rather than at the shared save.
        // Runs before any side effect (secrets, state) so a rejected document
        // leaves nothing half-written.
        parseAuthoredConfigShapeOrThrow(document);

        await this.ensureApplicationHasRepository(applicationId, organizationId);
        await this.ensureStateAtOrAfter(applicationId, "previewkit_configuring", "save PreviewKit config");

        // Secrets before the config commit. If a secret write throws, the config never
        // saves, so the two stay consistent (the rare residual - secrets written,
        // config not - is the safe direction: extra secret values are harmless until
        // referenced).
        await this.upsertConfigSecrets(applicationId, organizationId, document, secrets);

        const saved = await this.previewkitConfig.save(applicationId, organizationId, document);

        // Deletes run after the commit so a rolled-back config can never end up
        // referencing a secret we already removed. Best-effort: a leftover secret
        // is harmless, so we log and continue rather than fail the saved config.
        await this.deleteConfigSecrets(applicationId, organizationId, secrets);

        await this.sdkCapability.ensureManagedSharedSecretForConfig(applicationId, organizationId, saved.document);

        return saved;
    }

    /**
     * Validate secret app names against the document being saved, then upsert them
     * before the DB commit. The document is the whole topology, so a multirepo
     * dependency's app (which owns a secret bundle under this same Application)
     * is matched like any other.
     */
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
    ): Promise<PreviewkitConfigValidationResult> {
        this.logger.info("Validating onboarding PreviewKit config", { applicationId, organizationId });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        return this.previewkitConfig.validate(applicationId, organizationId, document);
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
        if (previewkitClient == null) {
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

        // Names what was started - branch, sha, workflow. Returned to the caller as `queued`, so
        // an agent waiting on this deploy can say which run it is waiting on; a request that
        // cannot name its run is undiagnosable without cluster access nobody here has.
        const receipt = await previewkitClient.deployApplicationMain(applicationId, organizationId);

        await this.db.onboardingState.update({
            where: { applicationId },
            data: {
                step: "previewkit_deploying",
                previewEnvironmentMode: "previewkit",
                previewVerificationStatus: "building",
                previewDeployRequestedAt: new Date(),
            },
        });

        this.logger.info("Queued the base preview deploy", {
            applicationId,
            organizationId,
            extra: {
                branch: receipt.branch,
                headSha: receipt.headSha,
                prNumber: receipt.prNumber,
                workflowId: receipt.workflowId,
            },
        });

        const readiness = await this.getPreviewReadiness(applicationId, organizationId);
        return { ...readiness, queued: receipt };
    }

    /**
     * Sets the branch the base preview (environment 0) deploys from - the app's
     * stored deploy ref, which {@link startMainBranchRun} resolves at deploy time.
     * Unset means the app's trunk; this is how a coding agent or the UI redirects
     * the base preview at an integration branch that isn't merged yet.
     *
     * This writes ONLY the deploy ref. It deliberately leaves the main-branch
     * record alone: that record is the app's trunk identity, and it drives suite
     * lineage, merge reconciliation and every "main" label in the product, so
     * pointing it at an integration branch silently redefines what main means.
     *
     * Persisting the branch is separate from triggering a deploy, so the branch can
     * be picked without deploying yet. The branch is validated against GitHub (a 404
     * means it doesn't exist) so a typo can't silently break the deploy.
     */
    async setDeployBranch(applicationId: string, organizationId: string, branch: string): Promise<{ branch: string }> {
        this.logger.info("Setting PreviewKit deploy branch", { applicationId, organizationId, extra: { branch } });
        await this.ensureApplicationHasRepository(applicationId, organizationId);
        await this.ensureStateAtOrAfter(applicationId, "previewkit_configuring", "set deploy branch");

        const normalized = normalizeBranchName(branch);
        if (normalized === "") throw new BadRequestError("Branch name is required");

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });
        if (application == null) throw new NotFoundError("Application not found");

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

        await this.db.application.update({
            where: { id: applicationId },
            data: { previewDeployRef: normalized },
        });

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
                select: { previewDeployRef: true, mainBranch: { select: { name: true } } },
            }),
            github?.listApplicationBranches(organizationId, applicationId).catch((err: unknown) => {
                this.logger.warn("Failed to list branches from GitHub; deploy-branch picker falls back to free text", {
                    applicationId,
                    err,
                });
                return undefined;
            }),
        ]);

        const currentBranch = application == null ? undefined : applicationBranchRefs(application).deploy;
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

        return buildPreviewkitReadiness(this.db, {
            applicationId,
            organizationId,
            step: state.step,
            previousStatus: state.previewVerificationStatus,
            // The deploy-request time, NOT the row's `updatedAt`: the latter is bumped
            // by unrelated writes (the agent heartbeat) and would drift past the moment
            // the environment goes ready, so the deploy would never be observed as ready.
            // Fall back to `updatedAt` only for rows predating this column.
            previousStatusUpdatedAt: state.previewDeployRequestedAt ?? state.updatedAt,
            previousError: state.previewVerificationError ?? undefined,
        });
    }

    /** Verify the preview is ready and take the app live. */
    async completePreviewOnboarding(applicationId: string, organizationId: string) {
        this.logger.info("Completing preview onboarding", { applicationId, organizationId });
        const readiness = await this.getPreviewReadiness(applicationId, organizationId);
        const state = await this.completeVerifiedPreview(applicationId, readiness);
        // Activation belongs to whichever transition lands `completed`, and this is now that
        // transition. It used to hang off `goLive` alone, so leaving it there would have left the
        // main branch's first uploaded suite staged forever on the path the UI takes.
        await this.activatePendingSnapshot(applicationId, organizationId);
        return state;
    }

    /**
     * The transition itself, against a readiness the caller has already read.
     *
     * Reading readiness is not free - it upserts, rebuilds diagnostics, and can reach
     * out to the preview - and it is also what STAMPS a preview that has come up, so a
     * caller that has to inspect readiness before deciding cannot skip it. Taking it as
     * an argument lets {@link takeLive} decide and transition on one read instead of two.
     */
    private async completeVerifiedPreview(applicationId: string, readiness: PreviewReadiness) {
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
        return this.getState(applicationId);
    }

    /**
     * Take a verified preview all the way to live, in one idempotent call.
     *
     * Both callers that do this - the MCP's `go_live` tool and the planner CLI once
     * its preview phase confirms - need the same two transitions behind the same three
     * guards. Kept here rather than at either caller so "what going live means" cannot
     * come to mean two different things, and so a caller cannot half-do it.
     *
     * Idempotent on purpose. The CLI calls it every run without first asking whether
     * an agent already did, and an app that is already live returns `alreadyLive`
     * rather than erroring or moving backwards.
     */
    async takeLive(applicationId: string, organizationId: string): Promise<TakeLiveResult> {
        this.logger.info("Taking the app live", { applicationId, organizationId });

        // Reading readiness is what stamps a preview that has come up as
        // `preview_verified` - no other call does - so the step read below is only
        // current once this has run. It also carries the diagnostics that make a
        // refusal actionable ("your preview is failed", not "wrong step").
        const readiness = await this.getPreviewReadiness(applicationId, organizationId);
        const before = await this.getState(applicationId);

        if (hasGoneLive(before.step)) {
            this.logger.info("App is already live", { applicationId });
            return { step: before.step, alreadyLive: true, transitions: [], state: before };
        }
        if (!isStepAtOrPast(before.step, "preview_verified")) {
            throw new BadRequestError(describeUnfinishedStep(before.step, readiness.diagnostics.status));
        }
        // A verified app whose preview is rebuilding keeps its step but loses its
        // readiness, and the state machine's own guard for that says only "Preview
        // environment is not ready yet".
        if (before.step === "preview_verified" && readiness.diagnostics.status !== "ready") {
            throw new BadRequestError(describeUnverifiedPreview(readiness.diagnostics.status));
        }

        // One transition now, not two: verifying the preview lands `completed` directly.
        if (before.step === "preview_verified") {
            await this.completeVerifiedPreview(applicationId, readiness);
            await this.activatePendingSnapshot(applicationId, organizationId);
            const state = await this.getState(applicationId);
            return { step: state.step, alreadyLive: false, transitions: ["preview_verified -> completed"], state };
        }

        // Rows parked at `diff_trigger` before that step was retired. Nothing arrives here any
        // more, but the ones already there still have to be able to finish.
        const after = await this.goLive(applicationId, organizationId);
        return { step: after.step, alreadyLive: false, transitions: ["diff_trigger -> completed"], state: after };
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
                sdkUrl: body.sdkUrl,
            });
            if (triggered && application.onboardingState.diffTriggerConfirmedAt == null) {
                await this.db.onboardingState.update({
                    where: { applicationId: application.id },
                    data: { diffTriggerConfirmedAt: new Date() },
                });
            }
            this.recordDeploymentSignal(application, application.onboardingState, "pr_diffs_triggered");
            return { ok: true, applicationId: application.id, previewUrl: body.previewUrl, ignored: false };
        }

        if (isNonMainBranch) {
            this.logger.info("Ignoring deployment signal for non-main branch with no PR number", {
                applicationId: application.id,
                signalBranch: body.branch,
                mainBranch: mainBranchName,
            });
            this.recordDeploymentSignal(application, application.onboardingState, "ignored");
            return { ok: true, applicationId: application.id, previewUrl: body.previewUrl, ignored: true };
        }

        const write = await writePreviewUrl(this.db, {
            applicationId: application.id,
            organizationId: application.organizationId,
            previewUrl: body.previewUrl,
        });
        this.recordDeploymentSignal(application, application.onboardingState, "preview_recorded");
        // The signal endpoint is a raw HTTP handler, so no tracker wraps it: on the
        // bring-your-own-deploys path this is the only thing that reaches
        // `preview_verified`, and it would otherwise be absent from the funnel.
        if (write.advancedToVerified) {
            await this.analytics.stepAdvanced(machineActor(application), "deployment_signal", "signal", write.fromStep);
        }
        if (hasGoneLive(application.onboardingState.step)) {
            await this.triggerDiffsFromSignal(application.id, application.organizationId, {
                repoId: application.githubRepositoryId ?? undefined,
                previewUrl: body.previewUrl,
                sdkUrl: body.sdkUrl,
            });
        }

        return { ok: true, applicationId: application.id, previewUrl: body.previewUrl, ignored: false };
    }

    /**
     * Record what an accepted deployment signal did. The signal endpoint is the
     * only thing that advances the bring-your-own-deploys path, and it is called
     * by the customer's CI rather than a user - so nothing else in the funnel can
     * tell "their workflow never fired" apart from "their workflow fired and we
     * ignored it".
     */
    private recordDeploymentSignal(
        application: SignalledApplication,
        state: SignalledOnboardingState,
        outcome: DeploymentSignalEvent["outcome"],
    ): void {
        this.analytics.deploymentSignalReceived({
            organizationId: application.organizationId,
            applicationId: application.id,
            outcome,
            stepBefore: state.step,
            previewEnvironmentMode: state.previewEnvironmentMode ?? undefined,
        });
    }

    /**
     * Fan a deployment signal out to diff analysis using the preview URL it
     * carries. Best-effort: a diff-trigger failure must not fail the signal (the
     * URL is already recorded). Returns whether a diff job was triggered.
     */
    private async triggerDiffsFromSignal(
        applicationId: string,
        organizationId: string,
        params: { repoId?: number; prNumber?: number; previewUrl: string; sdkUrl?: string },
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

        // A deployment whose SDK endpoint is on a different origin than its browser
        // URL (split UI/API host) supplies an explicit sdkUrl; otherwise the webhook
        // is the single-origin convention `<previewUrl>/api/autonoma`.
        const webhookUrl = params.sdkUrl ?? buildSdkUrl(params.previewUrl);
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

    /**
     * Just how an app gets its previews. Split out from
     * {@link getExternalSignalStatus} because the MCP checks it before every
     * config write, and pulling five columns to read one is wasted work on a
     * path where the guard almost always passes.
     */
    async getPreviewEnvironmentMode(applicationId: string, organizationId: string) {
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { onboardingState: { select: { previewEnvironmentMode: true } } },
        });
        if (application == null) throw new NotFoundError("Application not found");
        return application.onboardingState?.previewEnvironmentMode ?? undefined;
    }

    /**
     * The bring-your-own-deploys wiring, as a coding agent needs to see it: which
     * preview path the app is on, whether a signed signal has landed, and whether
     * one has ever carried a PR (which is what per-PR reviews require).
     *
     * Deliberately not `getState`: that is the UI's polled read and fans out into
     * half a dozen queries for artifacts, scenarios and test cases the agent has
     * no use for here.
     */
    async getExternalSignalStatus(applicationId: string, organizationId: string) {
        this.logger.info("Loading external signal status", { applicationId, organizationId });
        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: {
                onboardingState: {
                    select: {
                        step: true,
                        previewEnvironmentMode: true,
                        previewUrl: true,
                        diffTriggerConfirmedAt: true,
                    },
                },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");
        const state = application.onboardingState;

        return {
            step: state?.step,
            previewEnvironmentMode: state?.previewEnvironmentMode ?? undefined,
            signalReceived: state?.previewUrl != null,
            previewUrl: state?.previewUrl ?? undefined,
            prReviewsConfirmed: state?.diffTriggerConfirmedAt != null,
            prReviewsConfirmedAt: state?.diffTriggerConfirmedAt?.toISOString(),
        };
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

    async listVercelDeployments(applicationId: string, organizationId: string) {
        return this.vercelCapability.listVercelDeployments(applicationId, organizationId);
    }

    /**
     * Redeploys a chosen Vercel deployment so it rebuilds with the injected
     * `AUTONOMA_SHARED_SECRET`, returning the NEW deployment's id/url/state for
     * the UI to poll. Committing the preview URL happens in `selectVercelDeployment`
     * once the poll reports READY.
     */
    async redeployVercelDeployment(
        applicationId: string,
        organizationId: string,
        vercelDeploymentId: string,
    ): Promise<VercelRedeployResult> {
        this.logger.info("Redeploying Vercel deployment", { applicationId, vercelDeploymentId });
        return this.vercelCapability.redeployVercelDeployment(applicationId, organizationId, vercelDeploymentId);
    }

    /** Current build state of a (re)deployed Vercel deployment, for the UI's readiness poll. */
    async getVercelDeploymentStatus(
        applicationId: string,
        organizationId: string,
        vercelDeploymentId: string,
    ): Promise<VercelDeploymentStatusResult> {
        this.logger.info("Fetching Vercel deployment status", { applicationId, vercelDeploymentId });
        return this.vercelCapability.getVercelDeploymentStatus(applicationId, organizationId, vercelDeploymentId);
    }

    async selectVercelDeployment(
        applicationId: string,
        organizationId: string,
        vercelDeploymentId: string,
    ): Promise<OnboardingStateView> {
        this.logger.info("Selecting Vercel deployment", { applicationId, vercelDeploymentId });
        await this.vercelCapability.selectVercelDeployment(applicationId, organizationId, vercelDeploymentId);
        return this.getState(applicationId);
    }

    /**
     * Finish-setup SDK validation for a Vercel app: discover against the chosen
     * (READY) Vercel deployment using the stored shared secret. On a shared-secret
     * drift 401 - the deployment was built before we injected the secret - and
     * only when `allowRedeploy` is set, kicks off exactly one redeploy and returns
     * its new deployment id so the UI can poll + auto-retry.
     */
    async discoverVercelDeploymentTarget(
        applicationId: string,
        organizationId: string,
        vercelDeploymentId: string,
        allowRedeploy: boolean,
    ): Promise<DiscoverVercelDeploymentTargetResult> {
        this.logger.info("Discovering Vercel deployment SDK target", {
            applicationId,
            vercelDeploymentId,
            extra: { allowRedeploy },
        });

        const sdkUrl = await this.vercelCapability.resolveReadyDeploymentSdkUrl(
            applicationId,
            organizationId,
            vercelDeploymentId,
        );

        try {
            await this.sdkCapability.configureAndDiscoverStoredSecret(applicationId, organizationId, sdkUrl);
            return { status: "discovered" };
        } catch (err) {
            if (allowRedeploy && isSharedSecretDrift401(err)) {
                const { deploymentId } = await this.vercelCapability.redeployVercelDeployment(
                    applicationId,
                    organizationId,
                    vercelDeploymentId,
                );
                // A secret-drift 401 is not a terminal failure - we own the secret
                // and are redeploying to sync it - so clear the error the discover
                // attempt just persisted, mirroring the managed-target self-heal.
                await this.db.onboardingState.update({
                    where: { applicationId },
                    data: { discoveringStartedAt: null, lastDiscoveryError: null },
                });
                this.logger.info("Vercel SDK discover hit secret drift; redeploy started", {
                    applicationId,
                    extra: { newDeploymentId: deploymentId },
                });
                return { status: "redeploy_started", deploymentId };
            }
            throw err;
        }
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
    async runScenarioDryRun(request: ScenarioDryRunRequest): Promise<ScenarioDryRunResult> {
        this.logger.info("Running scenario dry run", {
            applicationId: request.applicationId,
            extra: { scenarioId: request.scenarioId, targetId: request.targetId },
        });
        return this.sdkCapability.runDryRun(request);
    }

    /**
     * SDK capability: list the preview envs the dry-run can target (open-PR
     * previews + main), flagging the auto-detected SDK implementation PR.
     */
    async listSdkDryRunTargets(applicationId: string, organizationId: string) {
        this.logger.info("Listing SDK dry-run targets", { applicationId, organizationId });
        return this.sdkCapability.listTargets(applicationId, organizationId);
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

    /**
     * Authorize a read: the application must belong to the caller's organization.
     *
     * Reads that take an `applicationId` and nothing else are only safe when an
     * internal caller has already established the org - after a write that
     * authorized, or behind the MCP's `resolveOrg`. Anything reachable from an
     * untrusted caller has to come through here first, or an id alone is enough to
     * read another organization's app. A missing app and a foreign app throw the
     * same error, so this cannot be used to probe which ids exist.
     */
    async assertApplicationInOrg(applicationId: string, organizationId: string): Promise<void> {
        await assertApplicationInOrg(this.db, applicationId, organizationId);
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
                previewkitConfig: { include: previewkitConfigRowsInclude },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");
        if (application.previewkitConfig == null) {
            throw new ConflictError("Save a valid PreviewKit config before starting a deploy");
        }

        const validation = previewConfigSchema.safeParse(
            documentFromPreviewkitConfigRows(application.previewkitConfig),
        );
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
                previewkitConfig: { include: previewkitConfigRowsInclude },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");
        const stored = application.previewkitConfig;
        if (stored == null) {
            throw new ConflictError("Save a valid PreviewKit config before managing secrets");
        }

        const parsed = previewConfigSchema.safeParse(documentFromPreviewkitConfigRows(stored));
        if (!parsed.success) {
            throw new ConflictError(`Saved PreviewKit config is invalid: ${z.prettifyError(parsed.error)}`);
        }

        const appNames = new Set(parsed.data.apps.map((app) => app.name));
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
     * Activate the application's main-branch pending snapshot after onboarding completes. The uploaded tests are
     * not run here - they run when a PR first triggers an analysis on them.
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
            const promoted = await this.promoteIfStillOpen(pendingSnapshotId, organizationId);
            if (!promoted) {
                // Benign: a concurrent/duplicate signal already activated this
                // snapshot (go-live + a later setup-completion both target it).
                this.logger.info("Pending snapshot already activated - skipping", {
                    applicationId,
                    branchId,
                    snapshotId: pendingSnapshotId,
                });
                return;
            }
            this.logger.info("Pending snapshot activated", { applicationId, branchId });
        } catch (err) {
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

    /**
     * Promote the snapshot, reporting `false` rather than throwing when it has already settled - whether the race
     * was lost at the reopen or at the promote itself. Both are the same benign duplicate signal.
     */
    private async promoteIfStillOpen(snapshotId: string, organizationId: string): Promise<boolean> {
        try {
            const snapshot = await this.suite.reopen(snapshotId, { organizationId });
            return await snapshot.promote();
        } catch (err) {
            if (err instanceof SnapshotNotOpenError || err instanceof SnapshotNotFoundError) return false;
            throw err;
        }
    }
}

/**
 * The resolved onboarding state returned by `getState`: the persisted row plus
 * the derived flags (`sdkConfigured`, `setupComplete`, ...). `Awaited<...>`
 * unwraps the promise so callers annotate a flat value, not `Promise<Promise<T>>`.
 */
export type OnboardingStateView = Awaited<ReturnType<OnboardingManager["getState"]>>;
