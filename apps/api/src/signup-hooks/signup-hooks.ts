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
            organizationId: params.organizationId,
        });

        const hookState = await this.getOrCreateHookState(params.db, params.userId, params.organizationId);

        const allHooksComplete =
            hookState.newsletterAddedAt != null &&
            hookState.defaultWelcomeEmailSentAt != null &&
            hookState.premiumWelcomeEmailSentAt != null;
        if (allHooksComplete) {
            this.logger.debug("All signup hooks already complete", { userId: params.userId });
            return;
        }

        const isPremium = await this.isOrgPremium(params.db, params.organizationId);
        const normalizedName = this.normalizeUserName(params.name, params.email);
        const nameParts = normalizedName.split(/\s+/);
        const firstName = nameParts[0];
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : undefined;

        await this.runHooks(params, hookState, isPremium, normalizedName, firstName, lastName, "signup");
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

        const allHooksComplete =
            hookState.newsletterAddedAt != null &&
            hookState.defaultWelcomeEmailSentAt != null &&
            hookState.premiumWelcomeEmailSentAt != null;
        if (allHooksComplete) return;

        this.logger.info("Running authentication catch-up hooks", {
            userId: params.userId,
            organizationId: params.organizationId,
        });

        const isPremium = await this.isOrgPremium(params.db, params.organizationId);
        const normalizedName = this.normalizeUserName(params.name, params.email);
        const nameParts = normalizedName.split(/\s+/);
        const firstName = nameParts[0];
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : undefined;

        await this.runHooks(params, hookState, isPremium, normalizedName, firstName, lastName, "catch-up");
    }

    private async runHooks(
        params: {
            db: PrismaClient;
            userId: string;
            email: string;
            organizationId: string;
            orgName: string;
            orgSlug: string;
        },
        hookState: {
            newsletterAddedAt: Date | null;
            defaultWelcomeEmailSentAt: Date | null;
            premiumWelcomeEmailSentAt: Date | null;
        },
        isPremium: boolean,
        normalizedName: string,
        firstName: string | undefined,
        lastName: string | undefined,
        source: string,
    ): Promise<void> {
        const claimedJobs: Array<{ label: HookLabel; field: HookField; run: () => Promise<void> }> = [];

        if (hookState.newsletterAddedAt == null) {
            const claimed = await this.claimHookField(
                params.db,
                params.userId,
                params.organizationId,
                "newsletterAddedAt",
            );
            if (claimed) {
                claimedJobs.push({
                    label: "newsletter",
                    field: "newsletterAddedAt",
                    run: () => this.addToNewsletter(params.email, firstName, lastName),
                });
            }
        }

        if (!isPremium && hookState.defaultWelcomeEmailSentAt == null) {
            const claimed = await this.claimHookField(
                params.db,
                params.userId,
                params.organizationId,
                "defaultWelcomeEmailSentAt",
            );
            if (claimed) {
                const channelResult = await this.setupCommunicationChannel(params, false);
                claimedJobs.push({
                    label: "default-welcome-email",
                    field: "defaultWelcomeEmailSentAt",
                    run: () => this.sendWelcomeEmail(params.email, normalizedName, channelResult),
                });
            }
        }

        if (isPremium && hookState.premiumWelcomeEmailSentAt == null) {
            const claimed = await this.claimHookField(
                params.db,
                params.userId,
                params.organizationId,
                "premiumWelcomeEmailSentAt",
            );
            if (claimed) {
                const channelResult = await this.setupCommunicationChannel(params, true);
                if (channelResult?.type === "slack") {
                    claimedJobs.push({
                        label: "premium-welcome-email",
                        field: "premiumWelcomeEmailSentAt",
                        run: () => this.sendWelcomeEmail(params.email, normalizedName, channelResult),
                    });
                }
            }
        }

        if (claimedJobs.length === 0) {
            this.logger.debug("No hooks to run", { userId: params.userId, source });
            return;
        }

        this.logger.info(`Running ${claimedJobs.length} ${source} hook(s)`, {
            userId: params.userId,
            hooks: claimedJobs.map((j) => j.label),
        });

        const results = await Promise.allSettled(claimedJobs.map((j) => j.run()));

        for (const [index, result] of results.entries()) {
            if (result.status === "rejected") {
                const job = claimedJobs[index]!;
                this.logger.error(`Hook failed: ${job.label}`, { error: result.reason, userId: params.userId, source });
                await this.unclaimHookField(params.db, params.userId, params.organizationId, job.field);
            }
        }

        this.logger.info(`${source} hooks completed`, { userId: params.userId });
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

    /**
     * Uses a single conditional UPDATE so only one concurrent caller can flip a null timestamp to a value.
     */
    private async claimHookField(
        db: PrismaClient,
        userId: string,
        organizationId: string,
        field: HookField,
    ): Promise<boolean> {
        const result = await db.signupHookState.updateMany({
            where: {
                userId,
                organizationId,
                [field]: null,
            },
            data: {
                [field]: new Date(),
            },
        });
        return result.count > 0;
    }

    /**
     * Releases a previously claimed hook field so it can be retried on the next login.
     * Called when the external side-effect (email, newsletter) fails after claiming.
     */
    private async unclaimHookField(
        db: PrismaClient,
        userId: string,
        organizationId: string,
        field: HookField,
    ): Promise<void> {
        await db.signupHookState.update({
            where: {
                userId_organizationId: { userId, organizationId },
            },
            data: {
                [field]: null,
            },
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

type HookLabel = "newsletter" | "default-welcome-email" | "premium-welcome-email";
type HookField = "newsletterAddedAt" | "defaultWelcomeEmailSentAt" | "premiumWelcomeEmailSentAt";
