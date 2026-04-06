import { type Logger, logger } from "@autonoma/logger";
import { ErrorCode, type WebAPIPlatformError, WebClient } from "@slack/web-api";

export class SlackOnboardingService {
    private readonly logger: Logger;
    private readonly client: WebClient;

    constructor(private readonly botToken: string) {
        this.logger = logger.child({ name: this.constructor.name });
        this.client = new WebClient(this.botToken);
    }

    async createChannelAndInvite(params: {
        channelName: string;
        userEmail: string;
        orgName: string;
    }): Promise<{ channelId: string } | undefined> {
        this.logger.info("Ensuring Slack channel for org", {
            channelName: params.channelName,
            orgName: params.orgName,
        });

        const sanitizedName = this.sanitizeChannelName(params.channelName);
        const channelId = await this.getOrCreateChannelId(sanitizedName, params.orgName);
        if (channelId == null) return undefined;

        await this.client.conversations.setTopic({
            channel: channelId,
            topic: `Support channel for ${params.orgName}`,
        });

        // Send a Slack Connect invite so the customer can join from their own workspace
        const inviteResult = await this.client.conversations.inviteShared({
            channel: channelId,
            emails: [params.userEmail],
        });

        if (inviteResult.ok) {
            this.logger.info("Slack Connect invite sent", {
                channelId,
                email: params.userEmail,
            });
        } else {
            this.logger.warn("Failed to send Slack Connect invite", {
                channelId,
                email: params.userEmail,
                error: inviteResult.error,
            });
        }

        return { channelId };
    }

    private async getOrCreateChannelId(channelName: string, orgName: string): Promise<string | undefined> {
        try {
            const createResult = await this.client.conversations.create({
                name: channelName,
                is_private: false,
            });

            const channelId = createResult.channel?.id;
            if (channelId == null) {
                this.logger.error("Failed to create Slack channel - no channel ID returned", {
                    channelName,
                });
                return undefined;
            }

            this.logger.info("Slack channel created", { channelId, channelName, orgName });
            return channelId;
        } catch (error) {
            if (!this.isNameTakenError(error)) throw error;

            this.logger.info("Slack channel already exists, reusing it", {
                channelName,
                orgName,
            });

            const existingChannelId = await this.findChannelIdByName(channelName);
            if (existingChannelId == null) {
                this.logger.error("Slack channel name already exists but could not be found", {
                    channelName,
                    orgName,
                });
                return undefined;
            }

            return existingChannelId;
        }
    }

    private async findChannelIdByName(channelName: string): Promise<string | undefined> {
        let cursor: string | undefined;

        do {
            const result = await this.client.conversations.list({
                types: "public_channel",
                exclude_archived: true,
                limit: 1000,
                cursor,
            });

            const existingChannel = result.channels?.find((channel) => channel.name === channelName);
            if (existingChannel?.id != null) {
                return existingChannel.id;
            }

            cursor = result.response_metadata?.next_cursor || undefined;
        } while (cursor != null && cursor !== "");

        return undefined;
    }

    private isNameTakenError(error: unknown): error is WebAPIPlatformError {
        return (
            typeof error === "object" &&
            error != null &&
            "code" in error &&
            error.code === ErrorCode.PlatformError &&
            "data" in error &&
            typeof error.data === "object" &&
            error.data != null &&
            "error" in error.data &&
            error.data.error === "name_taken"
        );
    }

    private sanitizeChannelName(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 80);
    }
}
