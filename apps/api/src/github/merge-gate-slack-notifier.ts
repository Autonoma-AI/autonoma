import { type Logger, logger } from "@autonoma/logger";
import { WebClient } from "@slack/web-api";

export interface SkipSlackAlert {
    repoFullName: string;
    prNumber: number;
    actorLogin: string;
    openBugCount: number;
    /** The free-text reason from the `/autonoma-skip` comment, if the developer gave one. */
    reason?: string;
}

/**
 * Posts an internal "someone skipped the merge gate" alert to a Slack channel.
 */
export class MergeGateSlackNotifier {
    private readonly logger: Logger;
    private readonly client?: WebClient;

    constructor(
        botToken: string | undefined,
        private readonly channel: string | undefined,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
        this.client = botToken != null && botToken !== "" ? new WebClient(botToken) : undefined;
    }

    async notifySkip(alert: SkipSlackAlert): Promise<void> {
        if (this.client == null || this.channel == null || this.channel === "") {
            this.logger.debug("Merge gate: skip Slack alert not sent (bot token or channel not configured)");
            return;
        }
        this.logger.info("Merge gate: posting skip Slack alert", {
            extra: { repoFullName: alert.repoFullName, prNumber: alert.prNumber, actorLogin: alert.actorLogin },
        });
        try {
            const result = await this.client.chat.postMessage({
                channel: this.channel,
                text: buildSkipSlackText(alert),
            });
            if (result.ok !== true) {
                this.logger.warn("Merge gate: skip Slack alert was not acknowledged", {
                    extra: { error: result.error, channel: this.channel, prNumber: alert.prNumber },
                });
            }
        } catch (err) {
            this.logger.warn("Merge gate: failed to post skip Slack alert", {
                extra: { channel: this.channel, repoFullName: alert.repoFullName, prNumber: alert.prNumber },
                err,
            });
        }
    }
}

/** The Slack message body: who skipped, a link to the PR, the open-bug count, and the reason. */
function buildSkipSlackText(alert: SkipSlackAlert): string {
    const prUrl = `https://github.com/${alert.repoFullName}/pull/${alert.prNumber}`;
    const bugs = `${alert.openBugCount} ${alert.openBugCount === 1 ? "bug" : "bugs"} open`;
    const reasonLine = alert.reason != null ? `> ${alert.reason.replace(/\s+/g, " ").trim()}` : "> _(no reason given)_";
    return [
        `⏭️ *Merge gate skipped* by \`@${alert.actorLogin}\``,
        `<${prUrl}|${alert.repoFullName}#${alert.prNumber}> · ${bugs}`,
        reasonLine,
    ].join("\n");
}
