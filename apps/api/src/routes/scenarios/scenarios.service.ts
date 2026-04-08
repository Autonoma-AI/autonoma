import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { DryRunSubject } from "../onboarding/dry-run-subject";
import { Service } from "../service";

export class ScenariosService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly scenarioManager: ScenarioManager,
        private readonly encryption: EncryptionHelper,
    ) {
        super();
    }

    async configureWebhook(applicationId: string, organizationId: string, webhookUrl: string, signingSecret: string) {
        this.logger.info("Configuring webhook", { applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const signingSecretEnc = this.encryption.encrypt(signingSecret);

        const result = await this.db.application.update({
            where: { id: applicationId },
            data: { webhookUrl, signingSecretEnc },
        });

        this.logger.info("Webhook configured", { applicationId });

        return result;
    }

    async removeWebhook(applicationId: string, organizationId: string) {
        this.logger.info("Removing webhook and associated scenarios", { applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const [updatedApp] = await this.db.$transaction([
            this.db.application.update({
                where: { id: applicationId },
                data: { webhookUrl: null, signingSecretEnc: null },
            }),
            this.db.scenario.deleteMany({
                where: { applicationId },
            }),
        ]);

        this.logger.info("Webhook removed", { applicationId });

        return updatedApp;
    }

    async discover(applicationId: string, organizationId: string) {
        this.logger.info("Discovering scenarios", { applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        await this.scenarioManager.discover(applicationId);

        const scenarios = await this.db.scenario.findMany({
            where: { applicationId },
            orderBy: { name: "asc" },
        });

        this.logger.info("Scenarios discovered", { applicationId, count: scenarios.length });

        return scenarios;
    }

    async listScenarios(applicationId: string, organizationId: string) {
        this.logger.info("Listing scenarios", { applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        return this.db.scenario.findMany({
            where: { applicationId },
            orderBy: { name: "asc" },
        });
    }

    async listInstances(scenarioId: string, organizationId: string) {
        this.logger.info("Listing scenario instances", { scenarioId });

        const scenario = await this.db.scenario.findFirst({
            where: { id: scenarioId, application: { organizationId } },
        });
        if (scenario == null) throw new NotFoundError("Scenario not found");

        return this.db.scenarioInstance.findMany({
            where: { scenarioId },
            orderBy: { requestedAt: "desc" },
        });
    }

    async listWebhookCalls(applicationId: string, organizationId: string) {
        this.logger.info("Listing webhook calls", { applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        return this.db.webhookCall.findMany({
            where: { applicationId },
            orderBy: { createdAt: "desc" },
            take: 50,
        });
    }

    async dryRun(applicationId: string, organizationId: string, scenarioId: string) {
        this.logger.info("Running scenario dry run", { applicationId, scenarioId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const subject = new DryRunSubject(this.db, applicationId);
        const instance = await this.scenarioManager.up(subject, scenarioId);

        if (instance.status === "UP_FAILED") {
            this.logger.info("Dry run failed during up phase", { applicationId, scenarioId });
            return { success: false as const, phase: "up" as const, error: instance.lastError };
        }

        const downResult = await this.scenarioManager.down(instance.id);

        if (downResult?.status === "DOWN_FAILED") {
            this.logger.info("Dry run failed during down phase", { applicationId, scenarioId });
            return { success: false as const, phase: "down" as const, error: downResult.lastError };
        }

        this.logger.info("Dry run succeeded", { applicationId, scenarioId });
        return { success: true as const, phase: "down" as const, error: undefined };
    }
}
