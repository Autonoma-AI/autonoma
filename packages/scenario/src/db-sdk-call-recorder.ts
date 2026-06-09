import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import type { SdkCallEvent, SdkCallRecorder } from "./sdk-call-recorder";

/**
 * Persists every SDK endpoint call attempt to the `webhookCall` table for
 * customer-debugging UX. Failures to write are swallowed and logged so the
 * caller never has to defend against logging errors.
 */
export class DbSdkCallRecorder implements SdkCallRecorder {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async record(event: SdkCallEvent): Promise<void> {
        try {
            await this.db.webhookCall.create({
                data: {
                    applicationId: event.applicationId,
                    instanceId: event.instanceId,
                    action: event.action,
                    requestBody: event.requestBody as object,
                    responseBody: event.responseBody != null ? (event.responseBody as object) : undefined,
                    statusCode: event.statusCode,
                    durationMs: event.durationMs,
                    error: event.error,
                },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error("Failed to persist SDK call event", { error: message });
        }
    }
}
