import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { SlackNotifier, buildSlackRunCompletionMessage } from "@autonoma/notification";
import { Service } from "../service";

export class NotificationsService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async configureSlack(applicationId: string, organizationId: string, slackWebhookUrl: string) {
        this.logger.info("Configuring Slack notification", { applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const config = await this.db.notificationConfig.upsert({
            where: {
                applicationId_channel: { applicationId, channel: "SLACK" },
            },
            create: {
                channel: "SLACK",
                enabled: true,
                slackWebhookUrl,
                applicationId,
                organizationId,
            },
            update: {
                slackWebhookUrl,
                enabled: true,
            },
            select: {
                id: true,
                channel: true,
                enabled: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        this.logger.info("Slack notification configured", { applicationId, configId: config.id });
        return config;
    }

    async removeSlack(applicationId: string, organizationId: string) {
        this.logger.info("Removing Slack notification", { applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        await this.db.notificationConfig.deleteMany({
            where: { applicationId, channel: "SLACK" },
        });

        this.logger.info("Slack notification removed", { applicationId });
    }

    async getConfig(applicationId: string, organizationId: string) {
        this.logger.info("Getting notification config", { applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        return this.db.notificationConfig.findMany({
            where: { applicationId },
            select: {
                id: true,
                channel: true,
                enabled: true,
                createdAt: true,
                updatedAt: true,
            },
            orderBy: { createdAt: "desc" },
        });
    }

    async testSlack(applicationId: string, organizationId: string) {
        this.logger.info("Testing Slack notification", { applicationId });

        const application = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
        });
        if (application == null) throw new NotFoundError("Application not found");

        const config = await this.db.notificationConfig.findUnique({
            where: {
                applicationId_channel: { applicationId, channel: "SLACK" },
            },
        });
        if (config?.slackWebhookUrl == null) throw new NotFoundError("Slack notification not configured");

        const payload = buildSlackRunCompletionMessage({
            testName: "Test notification",
            applicationName: application.name,
            status: "success",
            runUrl: "#",
        });

        const notifier = new SlackNotifier({ webhookUrl: config.slackWebhookUrl });
        await notifier.send(payload);

        this.logger.info("Slack test notification sent", { applicationId });
        return { success: true };
    }
}
