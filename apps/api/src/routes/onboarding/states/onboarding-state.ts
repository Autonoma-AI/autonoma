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
 * The required path is `github (Add app) -> preview_environment ->
 * (previewkit_configuring | existing_deploys_*) -> preview_verified ->
 * diff_trigger -> completed`. Each step is a concrete subclass that overrides
 * only the transitions valid for that step; all others throw
 * {@link InvalidOnboardingStepError}.
 *
 * SDK implementation + dry-run validation are NOT part of this path - they are
 * app-level capabilities run from the "Finish setup" tab and handled by
 * {@link OnboardingSdkCapabilityService} without touching `step`.
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

    /** Transition from `preview_verified` to `diff_trigger`. */
    completePreviewOnboarding(): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "complete preview onboarding");
    }

    /** Transition from `diff_trigger` to `completed`. */
    goLive(): Promise<void> {
        throw new InvalidOnboardingStepError(this.step, "go live");
    }
}
