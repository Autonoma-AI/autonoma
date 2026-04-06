import type { OnboardingStep, PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";

export interface OnboardingStateDeps {
    readonly scenarioManager: ScenarioManager;
    readonly encryption: EncryptionHelper;
}

export class InvalidOnboardingStepError extends Error {
    constructor(currentStep: string, attemptedAction: string) {
        super(`Cannot ${attemptedAction} during "${currentStep}" step`);
        this.name = "InvalidOnboardingStepError";
    }
}

export class OnboardingApplicationNotFoundError extends Error {
    constructor(applicationId: string) {
        super(`Application "${applicationId}" not found`);
        this.name = "OnboardingApplicationNotFoundError";
    }
}

export class OnboardingWebhookNotConfiguredError extends Error {
    constructor(applicationId: string) {
        super(`Application "${applicationId}" does not have a webhook configured`);
        this.name = "OnboardingWebhookNotConfiguredError";
    }
}

export class DryRunSubjectMisuseError extends Error {
    constructor(method: string) {
        super(`DryRunSubject.${method}() should not be called directly - pass the value explicitly`);
        this.name = "DryRunSubjectMisuseError";
    }
}

export interface ScenarioDryRunResult {
    success: boolean;
    phase: "up" | "down";
    error: unknown;
}

/**
 * Base class for the onboarding state machine (State pattern).
 *
 * Each step in the onboarding flow (install -> configure -> working ->
 * scenario_dry_run -> url -> completed) is represented by a concrete subclass that
 * overrides only the transitions valid for that step. All other transitions
 * throw {@link InvalidOnboardingStepError}.
 *
 * The {@link OnboardingManager} loads the appropriate subclass based on the
 * persisted step and delegates all mutations to it.
 */
export abstract class OnboardingState {
    abstract readonly step: OnboardingStep;
    protected readonly logger: Logger;

    constructor(
        protected readonly applicationId: string,
        protected readonly db: PrismaClient,
        protected readonly deps: OnboardingStateDeps,
    ) {
        this.logger = logger.child({ name: this.constructor.name, applicationId });
    }

    /** Transition from `install` to `configure`. */
    startConfigure(): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "start configure");
    }

    /** Transition from `configure` to `working` after the agent connects. */
    markAgentConnected(): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "mark agent connected");
    }

    /** Transition from `working` to `scenario_dry_run`. */
    startScenarioDryRun(): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "start scenario dry run");
    }

    /** Save webhook config and trigger scenario discovery. Only valid during `scenario_dry_run`. */
    configureAndDiscoverScenarios(_organizationId: string, _webhookUrl: string, _signingSecret: string): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "configure scenarios");
    }

    /** Execute a scenario up + down cycle. Only valid during `scenario_dry_run`. */
    runScenarioDryRun(_scenarioId: string): Promise<ScenarioDryRunResult> {
        throw new InvalidOnboardingStepError(this.step, "run scenario dry run");
    }

    /** Transition from `scenario_dry_run` to `url`. */
    complete(): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "complete onboarding");
    }

    /** Transition from `url` to `completed`, storing the production URL. */
    setUrl(_productionUrl: string): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "set url");
    }

    /** Reset onboarding back to `install`, clearing all progress. Available from any step. */
    async reset(): Promise<void> {
        this.logger.info("Resetting onboarding");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: {
                step: "install",
                agentConnectedAt: null,
                agentLogs: [],
                productionUrl: null,
                productionTestsPassed: false,
                completedAt: null,
            },
        });
    }
}
