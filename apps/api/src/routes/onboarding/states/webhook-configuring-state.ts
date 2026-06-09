import { type SdkCallOptions, SdkClient } from "@autonoma/scenario";
import { OnboardingApplicationNotFoundError, OnboardingState } from "./onboarding-state";

/**
 * The user is entering SDK URL + shared secret. `configureAndDiscoverScenarios`
 * validates the supplied config by calling discover *before* any persistence -
 * so a failed call can never leave the DB with a half-configured SDK endpoint
 * that poisons downstream state. Raised timeout handles typical
 * cold-start latency.
 */
const DRY_RUN_SDK_OPTIONS: SdkCallOptions = {
    timeoutMs: 90_000,
};

export class WebhookConfiguringState extends OnboardingState {
    readonly step = "webhook_configuring" as const;

    override async configureAndDiscoverScenarios(
        organizationId: string,
        webhookUrl: string,
        signingSecret: string,
        webhookHeaders?: Record<string, string>,
    ): Promise<void> {
        this.logger.info("Validating SDK config via discover");

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
            },
        });

        try {
            // Discover with the supplied (not-yet-persisted) config. No recorder:
            // the application row isn't pointed at this config yet, so there's
            // nothing meaningful to log against.
            const sdkClient = new SdkClient({
                applicationId: this.applicationId,
                sdkUrl: webhookUrl,
                signingSecret,
                customHeaders: webhookHeaders,
            });
            const response = await sdkClient.discover(DRY_RUN_SDK_OPTIONS);

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
            this.logger.info("Discovery succeeded; SDK config persisted", {
                modelCount: response.schema.models.length,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Discovery failed; leaving SDK unconfigured", { error: message });
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
