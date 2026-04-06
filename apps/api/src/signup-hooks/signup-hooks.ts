import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import { ResendOnboardingService } from "./resend.service";
import { SlackOnboardingService } from "./slack.service";

interface SignupHooksConfig {
    resendApiKey?: string;
    resendAudienceId?: string;
    resendFromEmail?: string;
    calLink?: string;
    slackBotToken?: string;
    discordInviteUrl?: string;
}

export class SignupHooks {
    private readonly logger: Logger;
    private readonly resend?: ResendOnboardingService;
    private readonly slack?: SlackOnboardingService;
    private readonly discordInviteUrl?: string;

    constructor(config: SignupHooksConfig) {
        this.logger = logger.child({ name: this.constructor.name });

        const hasResend =
            config.resendApiKey != null &&
            config.resendAudienceId != null &&
            config.resendFromEmail != null &&
            config.calLink != null;

        if (hasResend) {
            this.resend = new ResendOnboardingService(
                config.resendApiKey!,
                config.resendAudienceId!,
                config.resendFromEmail!,
                config.calLink!,
            );
            this.logger.info("Resend onboarding service initialized");
        } else {
            this.logger.warn("Resend onboarding service not configured - skipping email hooks");
        }

        if (config.slackBotToken != null) {
            this.slack = new SlackOnboardingService(config.slackBotToken);
            this.logger.info("Slack onboarding service initialized");
        } else {
            this.logger.warn("Slack onboarding service not configured - skipping Slack hooks");
        }

        this.discordInviteUrl = config.discordInviteUrl;
    }

    async onUserCreated(params: {
        db: PrismaClient;
        userId: string;
        email: string;
        name: string;
        organizationId: string;
        orgName: string;
        orgSlug: string;
    }): Promise<void> {
        this.logger.info("Running signup hooks", {
            userId: params.userId,
            email: params.email,
            organizationId: params.organizationId,
        });

        const hookState = await this.getOrCreateHookState(params.db, params.userId, params.organizationId);
        const normalizedName = this.normalizeUserName(params.name, params.email);
        const nameParts = normalizedName.split(/\s+/);
        const firstName = nameParts[0];
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : undefined;
        const isPremium = await this.isOrgPremium(params.db, params.organizationId);
        const jobs: Array<Promise<void>> = [];
        const jobNames: string[] = [];

        if (hookState.newsletterAddedAt == null) {
            jobs.push(this.addToNewsletter(params.email, firstName, lastName));
            jobNames.push("newsletter");
        }

        if (!isPremium && hookState.defaultWelcomeEmailSentAt == null) {
            const channelResult = await this.setupCommunicationChannel(params, false);
            jobs.push(this.sendWelcomeEmail(params.email, normalizedName, channelResult));
            jobNames.push("default-welcome-email");
        }

        if (isPremium && hookState.premiumWelcomeEmailSentAt == null) {
            const channelResult = await this.setupCommunicationChannel(params, true);
            if (channelResult?.type === "slack") {
                jobs.push(this.sendWelcomeEmail(params.email, normalizedName, channelResult));
                jobNames.push("premium-welcome-email");
            }
        }

        const results = await Promise.allSettled(jobs);

        for (const [index, result] of results.entries()) {
            if (result.status === "rejected") {
                this.logger.error(`Signup hook failed: ${jobNames[index]}`, {
                    error: result.reason,
                    userId: params.userId,
                });
            }
        }

        await this.markSuccessfulHooks(params.db, params.userId, params.organizationId, jobNames, results);

        this.logger.info("Signup hooks completed", { userId: params.userId });
    }

    async onUserAuthenticated(params: {
        db: PrismaClient;
        userId: string;
        email: string;
        name: string;
        organizationId: string;
        orgName: string;
        orgSlug: string;
    }): Promise<void> {
        const hookState = await this.getOrCreateHookState(params.db, params.userId, params.organizationId);
        if (hookState.premiumWelcomeEmailSentAt != null) return;

        const isPremium = await this.isOrgPremium(params.db, params.organizationId);
        if (!isPremium) return;

        const channelResult = await this.setupCommunicationChannel(params, true);
        if (channelResult?.type !== "slack") return;

        const normalizedName = this.normalizeUserName(params.name, params.email);
        await this.sendWelcomeEmail(params.email, normalizedName, channelResult);

        await params.db.signupHookState.update({
            where: {
                userId_organizationId: {
                    userId: params.userId,
                    organizationId: params.organizationId,
                },
            },
            data: {
                premiumWelcomeEmailSentAt: new Date(),
            },
        });
    }

    private async addToNewsletter(email: string, firstName?: string, lastName?: string): Promise<void> {
        if (this.resend == null) return;
        await this.resend.addToNewsletterAudience({ email, firstName, lastName });
    }

    private async sendWelcomeEmail(email: string, userName: string, channelResult?: ChannelResult): Promise<void> {
        if (this.resend == null) return;
        await this.resend.sendWelcomeEmail({ email, userName, channelResult });
    }

    private async setupCommunicationChannel(
        params: {
            db: PrismaClient;
            userId: string;
            email: string;
            organizationId: string;
            orgName: string;
            orgSlug: string;
        },
        isPremium: boolean,
    ): Promise<ChannelResult | undefined> {
        if (isPremium && this.slack != null) {
            const channelName = `autonoma-${params.orgSlug}`;
            try {
                const result = await this.slack.createChannelAndInvite({
                    channelName,
                    userEmail: params.email,
                    orgName: params.orgName,
                });
                if (result != null) {
                    return { type: "slack" };
                }
            } catch (error) {
                this.logger.error("Failed to create Slack channel", {
                    orgSlug: params.orgSlug,
                    error,
                });
            }
        } else if (!isPremium && this.discordInviteUrl != null) {
            return { type: "discord", inviteUrl: this.discordInviteUrl };
        }

        return undefined;
    }

    private async getOrCreateHookState(db: PrismaClient, userId: string, organizationId: string) {
        return await db.signupHookState.upsert({
            where: {
                userId_organizationId: {
                    userId,
                    organizationId,
                },
            },
            update: {},
            create: {
                userId,
                organizationId,
            },
        });
    }

    private async markSuccessfulHooks(
        db: PrismaClient,
        userId: string,
        organizationId: string,
        jobNames: string[],
        results: PromiseSettledResult<void>[],
    ): Promise<void> {
        const data: {
            newsletterAddedAt?: Date;
            defaultWelcomeEmailSentAt?: Date;
            premiumWelcomeEmailSentAt?: Date;
        } = {};

        for (const [index, result] of results.entries()) {
            if (result.status !== "fulfilled") continue;

            const jobName = jobNames[index];
            if (jobName === "newsletter") data.newsletterAddedAt = new Date();
            if (jobName === "default-welcome-email") data.defaultWelcomeEmailSentAt = new Date();
            if (jobName === "premium-welcome-email") data.premiumWelcomeEmailSentAt = new Date();
        }

        if (Object.keys(data).length === 0) return;

        await db.signupHookState.update({
            where: {
                userId_organizationId: {
                    userId,
                    organizationId,
                },
            },
            data,
        });
    }

    private async isOrgPremium(db: PrismaClient, organizationId: string): Promise<boolean> {
        const billing = await db.billingCustomer.findUnique({
            where: { organizationId },
            select: { subscriptionStatus: true },
        });

        return billing?.subscriptionStatus === "active";
    }

    private normalizeUserName(name: string, email: string): string {
        const trimmedName = name.trim();
        if (trimmedName !== "") {
            return trimmedName.replace(/\s+/g, " ");
        }

        const emailLocalPart = email.split("@")[0] ?? "there";
        const normalizedLocalPart = emailLocalPart
            .replace(/[._-]+/g, " ")
            .trim()
            .replace(/\s+/g, " ");

        return normalizedLocalPart === "" ? "there" : normalizedLocalPart;
    }
}

export interface ChannelResult {
    type: "slack" | "discord";
    inviteUrl?: string;
}
