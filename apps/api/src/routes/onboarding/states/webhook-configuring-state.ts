import type { WebhookCallOptions } from "@autonoma/scenario";
import { OnboardingApplicationNotFoundError, OnboardingState } from "./onboarding-state";

/**
 * The user is entering webhook URL + shared secret. `configureAndDiscoverScenarios`
 * validates the supplied config by calling the discover webhook *before* any
 * persistence — so a failed call can never leave the DB with a half-configured
 * webhook that poisons downstream state. Raised timeout + one retry handle
 * typical cold-start latency.
 */
const DRY_RUN_WEBHOOK_OPTIONS: WebhookCallOptions = {
    timeoutMs: 30_000,
    maxRetries: 1,
};

export class WebhookConfiguringState extends OnboardingState {
    readonly step = "webhook_configuring" as const;

    override async configureAndDiscoverScenarios(
        organizationId: string,
        webhookUrl: string,
        signingSecret: string,
        webhookHeaders?: Record<string, string>,
    ): Promise<void> {
        this.logger.info("Validating webhook config via discover");

        const app = await this.db.application.findFirst({
            where: { id: this.applicationId, organizationId },
            select: {
                id: true,
                mainBranch: {
                    select: { deployment: { select: { id: true } } },
                },
            },
        });
        if (app == null) {
            throw new OnboardingApplicationNotFoundError(this.applicationId);
        }

        const deploymentId = app.mainBranch?.deployment?.id;
        if (deploymentId == null) {
            throw new Error(`Application ${this.applicationId} does not have a main branch deployment`);
        }

        // Mark that a discover is in flight. Separate transaction so a crash
        // during the external call leaves the row at `discovering` with a
        // timestamp we can use to auto-recover.
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: {
                step: "discovering",
                discoveringStartedAt: new Date(),
                discoveryAttempts: { increment: 1 },
            },
        });

        try {
            const response = await this.deps.scenarioManager.discoverWithConfig({
                applicationId: this.applicationId,
                webhookUrl,
                signingSecret,
                webhookHeaders,
                options: DRY_RUN_WEBHOOK_OPTIONS,
            });

            const signingSecretEnc = this.deps.encryption.encrypt(signingSecret);
            await this.db.$transaction([
                this.db.application.update({
                    where: { id: this.applicationId },
                    data: { signingSecretEnc },
                }),
                this.db.branchDeployment.update({
                    where: { id: deploymentId },
                    data: { webhookUrl, webhookHeaders: webhookHeaders ?? undefined },
                }),
                this.db.onboardingState.update({
                    where: { applicationId: this.applicationId },
                    data: {
                        step: "discovered",
                        discoveringStartedAt: null,
                        lastDiscoveredAt: new Date(),
                        lastDiscoveredModels: response.schema.models.length,
                        lastDiscoveryError: null,
                    },
                }),
            ]);
            this.logger.info("Discovery succeeded; webhook config persisted", {
                modelCount: response.schema.models.length,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Discovery failed; leaving webhook unconfigured", { error: message });
            await this.db.onboardingState.update({
                where: { applicationId: this.applicationId },
                data: {
                    step: "webhook_configuring",
                    discoveringStartedAt: null,
                    lastDiscoveryError: message,
                },
            });
            throw err;
        }
    }
}
