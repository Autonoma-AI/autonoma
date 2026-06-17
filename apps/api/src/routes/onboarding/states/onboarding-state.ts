import type { OnboardingPreviewEnvironmentMode, OnboardingStep, PrismaClient } from "@autonoma/db";
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

export class OnboardingSdkNotConfiguredError extends Error {
    constructor(applicationId: string) {
        super(`Application "${applicationId}" does not have an SDK endpoint configured`);
        this.name = "OnboardingSdkNotConfiguredError";
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
 * Each step in the onboarding flow (webhook_configuring -> discovered ->
 * dry_run_passed -> github -> preview_environment -> preview_verified -> completed) is represented by a concrete
 * subclass that overrides only the transitions valid for that step. All other
 * transitions throw {@link InvalidOnboardingStepError}.
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

    /**
     * Validate the supplied webhook config by calling discover, then persist it
     * atomically on success. On failure, state is left at `webhook_configuring`
     * with `lastDiscoveryError` populated — the URL/secret are never persisted.
     */
    configureAndDiscoverScenarios(
        _organizationId: string,
        _webhookUrl: string,
        _signingSecret: string,
        _webhookHeaders?: Record<string, string>,
    ): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "configure scenarios");
    }

    /** Move from `discovered` / `dry_run_passed` back to `webhook_configuring` so the user can edit URL/secret. */
    reconfigureWebhook(): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "reconfigure webhook");
    }

    /** Execute a scenario up + down cycle. Valid during `discovered` and `dry_run_passed`. */
    runScenarioDryRun(_scenarioId: string): Promise<ScenarioDryRunResult> {
        throw new InvalidOnboardingStepError(this.step, "run scenario dry run");
    }

    /** Transition from `dry_run_passed` to `github` (optionally setting a production URL). */
    complete(_productionUrl?: string): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "complete onboarding");
    }

    /** Transition from `url` to `github`, storing the production URL. */
    setUrl(_productionUrl: string): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "set url");
    }

    /** Transition from `github` to `preview_environment`. */
    completeGithub(): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "complete github");
    }

    /** Select whether onboarding should use PreviewKit-managed deploys or existing deploys. */
    selectPreviewEnvironmentMode(_mode: OnboardingPreviewEnvironmentMode): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "select preview environment mode");
    }

    /**
     * Existing-deploys path: mark setup as finished and move to
     * `existing_deploys_waiting`, where onboarding waits for the first signed
     * deployment signal to arrive (which advances it to `preview_verified`).
     */
    confirmExistingDeploysSetup(): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "confirm existing deploys setup");
    }

    /** Transition from `preview_verified` to `completed`. */
    completePreviewOnboarding(): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "complete preview onboarding");
    }
}
