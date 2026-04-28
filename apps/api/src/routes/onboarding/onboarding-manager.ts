import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { type GenerationProvider, SnapshotNotPendingError, TestSuiteUpdater } from "@autonoma/test-updates";
import { CompletedState } from "./states/completed-state";
import { ConfigureState } from "./states/configure-state";
import { DiscoveredState } from "./states/discovered-state";
import { DiscoveringState } from "./states/discovering-state";
import { DryRunPassedState } from "./states/dry-run-passed-state";
import { GitHubState } from "./states/github-state";
import { InstallState } from "./states/install-state";
import type { OnboardingState, OnboardingStateDeps } from "./states/onboarding-state";
import { UrlState } from "./states/url-state";
import { WebhookConfiguringState } from "./states/webhook-configuring-state";
import { WorkingState } from "./states/working-state";

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
const STEP_ORDER: OnboardingState["step"][] = [
    "install",
    "configure",
    "working",
    "webhook_configuring",
    "discovering",
    "discovered",
    "dry_run_passed",
    "url",
    "github",
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
 * Flow: install -> configure -> working -> scenario_dry_run -> url -> github -> completed.
 * Reset is available from any step.
 */
export class OnboardingManager {
    private readonly logger: Logger;

    private static readonly states: Record<
        OnboardingState["step"],
        new (applicationId: string, db: PrismaClient, deps: OnboardingStateDeps) => OnboardingState
    > = {
        install: InstallState,
        configure: ConfigureState,
        working: WorkingState,
        webhook_configuring: WebhookConfiguringState,
        discovering: DiscoveringState,
        discovered: DiscoveredState,
        dry_run_passed: DryRunPassedState,
        url: UrlState,
        github: GitHubState,
        completed: CompletedState,
    };

    constructor(
        private readonly db: PrismaClient,
        private readonly generationProvider: GenerationProvider,
        private readonly scenarioManager: ScenarioManager,
        private readonly encryption: EncryptionHelper,
    ) {
        this.logger = logger.child({ name: "OnboardingManager" });
    }

    /** Return the persisted onboarding row, creating one at `install` if absent. */
    async getState(applicationId: string) {
        this.logger.info("Getting onboarding state", { applicationId });

        let row = await this.db.onboardingState.upsert({
            where: { applicationId },
            create: { applicationId },
            update: {},
        });

        // Crash recovery: if a prior discover call died mid-flight, the row is
        // stuck at `discovering` with `discoveringStartedAt` set. Roll back to
        // `webhook_configuring` so the user can retry.
        if (row.step === "discovering" && this.isDiscoveryStuck(row.discoveringStartedAt)) {
            this.logger.warn("Recovering stuck `discovering` state", {
                applicationId,
                discoveringStartedAt: row.discoveringStartedAt,
            });
            row = await this.db.onboardingState.update({
                where: { applicationId },
                data: {
                    step: "webhook_configuring",
                    discoveringStartedAt: null,
                    lastDiscoveryError: "Discovery timed out or crashed. Please retry.",
                },
            });
        }

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

    /** Move from `install` to `configure`. */
    async startConfigure(applicationId: string) {
        this.logger.info("Starting configure", { applicationId });
        const state = await this.loadState(applicationId);
        await state.startConfigure();
        return this.getState(applicationId);
    }

    /** Record that the agent has connected, moving from `configure` to `working`. */
    async markAgentConnected(applicationId: string) {
        this.logger.info("Marking agent connected", { applicationId });
        const state = await this.loadState(applicationId);
        await state.markAgentConnected();
        return this.getState(applicationId);
    }

    /** Move from `working` to `scenario_dry_run`. */
    async startScenarioDryRun(applicationId: string) {
        this.logger.info("Starting scenario dry run step", { applicationId });
        const state = await this.loadState(applicationId);
        await state.startScenarioDryRun();
        return this.getState(applicationId);
    }

    /** Store the production URL, move from `url` to `github`. Works from url or any later step. */
    async setUrl(applicationId: string, productionUrl: string) {
        this.logger.info("Setting production URL", { applicationId });
        const state = await this.loadStateOrEarlier(applicationId, "url");
        await state.setUrl(productionUrl);
        return this.getState(applicationId);
    }

    /** Move from `github` to `completed` and enqueue initial test generations. Works from github or completed. */
    async completeGithub(applicationId: string, organizationId: string) {
        this.logger.info("Completing GitHub step", { applicationId });
        const state = await this.loadStateOrEarlier(applicationId, "github");
        await state.completeGithub();
        await this.enqueueGenerations(applicationId, organizationId);
        return this.getState(applicationId);
    }

    /** Validate + persist webhook config. Works from working or any later step; auto-enters webhook_configuring. */
    async configureAndDiscoverScenarios(
        applicationId: string,
        organizationId: string,
        webhookUrl: string,
        signingSecret: string,
        webhookHeaders?: Record<string, string>,
    ) {
        this.logger.info("Configuring webhook for dry run", { applicationId });
        await this.transitionIfNeeded(applicationId, "working", "webhook_configuring");
        // Later steps (discovered, dry_run_passed) route to `webhook_configuring`'s
        // validate-then-persist logic so re-discovery goes through the same gate.
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

    /** Reset onboarding back to `install`, clearing all progress. Available from any step. */
    async reset(applicationId: string) {
        this.logger.info("Resetting onboarding", { applicationId });
        const state = await this.loadState(applicationId);
        await state.reset();
        return this.getState(applicationId);
    }

    /** Upsert the onboarding row and instantiate the matching state subclass. */
    private async loadState(applicationId: string): Promise<OnboardingState> {
        const initialOnboardingState = await this.db.onboardingState.upsert({
            where: { applicationId },
            create: { applicationId },
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
            create: { applicationId },
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

    /**
     * If the current step matches `fromStep`, automatically transition to `toStep`.
     * This allows operations to implicitly advance the state machine when the user
     * skips intermediate transition calls (e.g. navigating directly to a page).
     */
    private async transitionIfNeeded(
        applicationId: string,
        fromStep: OnboardingState["step"],
        toStep: OnboardingState["step"],
    ): Promise<void> {
        const row = await this.db.onboardingState.findUnique({
            where: { applicationId },
            select: { step: true },
        });
        if (row?.step === fromStep) {
            this.logger.info("Auto-transitioning onboarding step", { applicationId, from: fromStep, to: toStep });
            await this.db.onboardingState.update({
                where: { applicationId },
                data: { step: toStep },
            });
        }
    }

    private createOnboardingState(applicationId: string, step: OnboardingState["step"]): OnboardingState {
        const deps: OnboardingStateDeps = {
            scenarioManager: this.scenarioManager,
            encryption: this.encryption,
        };
        const stateConstructor = OnboardingManager.states[step];
        return new stateConstructor(applicationId, this.db, deps);
    }

    /** Queue test generations for the application's main branch after onboarding completes. */
    async enqueueGenerations(applicationId: string, organizationId: string) {
        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { mainBranch: { select: { id: true } } },
        });
        const branchId = app?.mainBranch?.id;

        if (branchId == null) return;

        try {
            this.logger.info("Enqueuing generations after onboarding complete", { applicationId, branchId });
            const updater = await TestSuiteUpdater.continueUpdate({
                db: this.db,
                branchId,
                organizationId,
                jobProvider: this.generationProvider,
            });
            await updater.queuePendingGenerations({ autoActivate: true });
            this.logger.info("Generations enqueued", { applicationId, branchId });
        } catch (err) {
            if (err instanceof SnapshotNotPendingError) {
                this.logger.info("No pending snapshot to enqueue - skipping", { applicationId, branchId });
            } else {
                // Log but don't block onboarding completion - generation queueing can be retried later
                this.logger.error("Failed to enqueue generations after onboarding", {
                    applicationId,
                    branchId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
}
