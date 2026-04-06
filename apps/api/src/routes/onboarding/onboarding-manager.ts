import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { type GenerationProvider, SnapshotNotPendingError, TestSuiteUpdater } from "@autonoma/test-updates";
import { CompletedState } from "./states/completed-state";
import { ConfigureState } from "./states/configure-state";
import { InstallState } from "./states/install-state";
import type { OnboardingState, OnboardingStateDeps } from "./states/onboarding-state";
import { ScenarioDryRunState } from "./states/scenario-dry-run-state";
import { UrlState } from "./states/url-state";
import { WorkingState } from "./states/working-state";

/**
 * Facade for the onboarding state machine.
 *
 * Every public method loads the current {@link OnboardingState} subclass from the
 * database and delegates the operation to it. This keeps the manager thin while
 * the state subclasses enforce which transitions are valid at each step.
 *
 * Flow: install -> configure -> working -> scenario_dry_run -> url -> completed.
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
        url: UrlState,
        scenario_dry_run: ScenarioDryRunState,
        completed: CompletedState,
        working: WorkingState,
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

        return await this.db.onboardingState.upsert({
            where: { applicationId },
            create: { applicationId },
            update: {},
        });
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

    /** Store the production URL, move from `url` to `completed`, and enqueue initial test generations. */
    async setUrl(applicationId: string, organizationId: string, productionUrl: string) {
        this.logger.info("Setting production URL", { applicationId });
        const state = await this.loadState(applicationId);
        await state.setUrl(productionUrl);
        await this.enqueueGenerations(applicationId, organizationId);
        return this.getState(applicationId);
    }

    /** Save webhook config and trigger scenario discovery. Only valid during `scenario_dry_run`. */
    async configureAndDiscoverScenarios(
        applicationId: string,
        organizationId: string,
        webhookUrl: string,
        signingSecret: string,
    ) {
        this.logger.info("Configuring webhook for dry run", { applicationId });
        const state = await this.loadState(applicationId);
        return state.configureAndDiscoverScenarios(organizationId, webhookUrl, signingSecret);
    }

    /** Execute a scenario up + down cycle to verify the webhook integration. Only valid during `scenario_dry_run`. */
    async runScenarioDryRun(applicationId: string, scenarioId: string) {
        this.logger.info("Running scenario dry run", { applicationId, scenarioId });
        const state = await this.loadState(applicationId);
        return state.runScenarioDryRun(scenarioId);
    }

    /** Move from `scenario_dry_run` to `url`. */
    async complete(applicationId: string) {
        this.logger.info("Completing scenario dry run", { applicationId });
        const state = await this.loadState(applicationId);
        await state.complete();
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
        const row = await this.db.onboardingState.upsert({
            where: { applicationId },
            create: { applicationId },
            select: { step: true },
            update: {},
        });
        const deps: OnboardingStateDeps = {
            scenarioManager: this.scenarioManager,
            encryption: this.encryption,
        };
        const stateConstructor = OnboardingManager.states[row.step];
        return new stateConstructor(applicationId, this.db, deps);
    }

    /** Queue test generations for the application's main branch after onboarding completes. */
    private async enqueueGenerations(applicationId: string, organizationId: string) {
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
                throw err;
            }
        }
    }
}
