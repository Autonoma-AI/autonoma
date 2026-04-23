import type { WebhookCallOptions } from "@autonoma/scenario";
import { DryRunSubject } from "../dry-run-subject";
import { OnboardingState, type ScenarioDryRunResult } from "./onboarding-state";

const DRY_RUN_WEBHOOK_OPTIONS: WebhookCallOptions = {
    timeoutMs: 30_000,
    maxRetries: 1,
};

/**
 * At least one dry-run has passed. User can re-run others, edit webhook config,
 * or move on by supplying a production URL and advancing to `github`.
 */
export class DryRunPassedState extends OnboardingState {
    readonly step = "dry_run_passed" as const;

    override async runScenarioDryRun(scenarioId: string): Promise<ScenarioDryRunResult> {
        this.logger.info("Re-running scenario dry run", { scenarioId });
        const subject = new DryRunSubject(this.db, this.applicationId);
        const instance = await this.deps.scenarioManager.up(subject, scenarioId, {
            webhookOptions: DRY_RUN_WEBHOOK_OPTIONS,
        });

        if (instance.status === "UP_FAILED") {
            return { success: false as const, phase: "up" as const, error: instance.lastError };
        }

        const downResult = await this.deps.scenarioManager.down(instance.id, DRY_RUN_WEBHOOK_OPTIONS);
        if (downResult?.status === "DOWN_FAILED") {
            return { success: false as const, phase: "down" as const, error: downResult.lastError };
        }
        return { success: true as const, phase: "down" as const, error: undefined };
    }

    override async reconfigureWebhook(): Promise<void> {
        this.logger.info("Returning to webhook_configuring from dry_run_passed");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "webhook_configuring" },
        });
    }

    override async complete(productionUrl?: string): Promise<void> {
        this.logger.info("Advancing from dry_run_passed to github", { hasProductionUrl: productionUrl != null });

        await this.db.$transaction(async (tx) => {
            await tx.onboardingState.update({
                where: { applicationId: this.applicationId },
                data: {
                    step: "github",
                    ...(productionUrl != null ? { productionUrl } : {}),
                },
            });

            if (productionUrl != null) {
                const app = await tx.application.findUnique({
                    where: { id: this.applicationId },
                    select: { mainBranch: { select: { deploymentId: true } } },
                });

                if (app?.mainBranch?.deploymentId != null) {
                    await tx.webDeployment.update({
                        where: { deploymentId: app.mainBranch.deploymentId },
                        data: { url: productionUrl },
                    });
                }
            }
        });
    }
}
