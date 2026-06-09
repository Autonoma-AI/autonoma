import type { SdkCallOptions } from "@autonoma/scenario";
import { DryRunSubject } from "../dry-run-subject";
import { OnboardingState, type ScenarioDryRunResult } from "./onboarding-state";

const DRY_RUN_SDK_OPTIONS: SdkCallOptions = {
    timeoutMs: 90_000,
};

/**
 * The SDK endpoint is configured and at least one successful discovery has
 * landed. User can run dry-runs. First successful dry-run advances the state to
 * `dry_run_passed`. User can also go back to edit SDK config via
 * `reconfigureWebhook`, or re-run discovery directly (treated as a fresh
 * attempt; URL/secret are only overwritten on success).
 */
export class DiscoveredState extends OnboardingState {
    readonly step = "discovered" as const;

    override async runScenarioDryRun(scenarioId: string): Promise<ScenarioDryRunResult> {
        this.logger.info("Running scenario dry run", { scenarioId });

        const subject = new DryRunSubject(this.db, this.applicationId);
        const instance = await this.deps.scenarioManager.up(subject, scenarioId, {
            sdkOptions: DRY_RUN_SDK_OPTIONS,
        });

        if (instance.status === "UP_FAILED") {
            return { success: false as const, phase: "up" as const, error: instance.lastError };
        }

        const downResult = await this.deps.scenarioManager.down(instance.id, DRY_RUN_SDK_OPTIONS);

        if (downResult?.status === "DOWN_FAILED") {
            return { success: false as const, phase: "down" as const, error: downResult.lastError };
        }

        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "dry_run_passed" },
        });
        return { success: true as const, phase: "down" as const, error: undefined };
    }

    override async reconfigureWebhook(): Promise<void> {
        this.logger.info("Returning to webhook_configuring to let user edit URL/secret");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "webhook_configuring" },
        });
    }
}
