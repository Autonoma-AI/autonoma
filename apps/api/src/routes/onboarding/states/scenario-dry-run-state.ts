import type { WebhookCallOptions } from "@autonoma/scenario";
import { DryRunSubject } from "../dry-run-subject";
import { OnboardingApplicationNotFoundError, OnboardingState } from "./onboarding-state";

/** Onboarding dry run uses short timeouts since the user is waiting interactively. */
const DRY_RUN_WEBHOOK_OPTIONS: WebhookCallOptions = {
    timeoutMs: 10_000,
    maxRetries: 0,
};

export class ScenarioDryRunState extends OnboardingState {
    readonly step = "scenario_dry_run" as const;

    override async configureAndDiscoverScenarios(
        organizationId: string,
        webhookUrl: string,
        signingSecret: string,
        webhookHeaders?: Record<string, string>,
    ): Promise<void> {
        this.logger.info("Configuring webhook for dry run");

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
        ]);

        await this.deps.scenarioManager.discover(this.applicationId, deploymentId, DRY_RUN_WEBHOOK_OPTIONS);
        this.logger.info("Webhook configured and scenarios discovered");
    }

    override async runScenarioDryRun(scenarioId: string) {
        this.logger.info("Running scenario dry run", { scenarioId });

        const subject = new DryRunSubject(this.db, this.applicationId);
        const instance = await this.deps.scenarioManager.up(subject, scenarioId, DRY_RUN_WEBHOOK_OPTIONS);

        if (instance.status === "UP_FAILED") {
            return { success: false as const, phase: "up" as const, error: instance.lastError };
        }

        const downResult = await this.deps.scenarioManager.down(instance.id, DRY_RUN_WEBHOOK_OPTIONS);

        if (downResult?.status === "DOWN_FAILED") {
            return { success: false as const, phase: "down" as const, error: downResult.lastError };
        }

        return { success: true as const, phase: "down" as const, error: undefined };
    }

    override async complete(): Promise<void> {
        this.logger.info("Completing scenario dry run, moving to url step");
        await this.db.onboardingState.update({
            where: { applicationId: this.applicationId },
            data: { step: "url" },
        });
    }
}
