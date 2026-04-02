import { type Logger, logger } from "@autonoma/logger";
import type { SlackMessage } from "./slack-message-builder";

export interface SlackNotifierConfig {
    webhookUrl: string;
    maxRetries?: number;
    timeoutMs?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export class SlackNotifier {
    private readonly logger: Logger;
    private readonly maxRetries: number;
    private readonly timeoutMs: number;

    constructor(private readonly config: SlackNotifierConfig) {
        this.logger = logger.child({ name: this.constructor.name });
        this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    async send(payload: SlackMessage): Promise<void> {
        this.logger.info("Sending Slack notification", { webhookUrl: this.redactUrl(this.config.webhookUrl) });

        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (attempt > 0) {
                const backoffMs = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
                this.logger.info("Retrying Slack notification", { attempt, backoffMs });
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }

            try {
                const response = await fetch(this.config.webhookUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(this.timeoutMs),
                });

                if (response.ok) {
                    this.logger.info("Slack notification sent successfully");
                    return;
                }

                lastError = new Error(`Slack webhook returned status ${response.status}`);
                this.logger.warn("Slack webhook returned non-OK status", {
                    status: response.status,
                    attempt: attempt + 1,
                });
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                this.logger.warn("Slack webhook request failed", {
                    error: lastError.message,
                    attempt: attempt + 1,
                });
            }
        }

        throw lastError ?? new Error(`Slack notification failed after ${this.maxRetries + 1} attempts`);
    }

    private redactUrl(url: string): string {
        try {
            const parsed = new URL(url);
            const pathParts = parsed.pathname.split("/");
            if (pathParts.length > 2) {
                return `${parsed.origin}/.../${pathParts[pathParts.length - 1]?.slice(0, 6)}...`;
            }
            return `${parsed.origin}/...`;
        } catch {
            return "<invalid-url>";
        }
    }
}
