import type { WebhookAction } from "@autonoma/db";

export type SdkAction = WebhookAction;

export interface SdkCallEvent {
    applicationId: string;
    instanceId?: string;
    action: SdkAction;
    requestBody: unknown;
    responseBody?: unknown;
    statusCode?: number;
    durationMs: number;
    error?: string;
}

/**
 * Sink for per-attempt SDK endpoint call observability.
 *
 * Implementations must be self-contained: `record()` must resolve successfully
 * even when the underlying sink fails. The recorder is responsible for swallowing
 * and logging its own errors so the caller never has to wrap the call in a
 * defensive `try/catch`.
 */
export interface SdkCallRecorder {
    record(event: SdkCallEvent): Promise<void>;
}

export const NOOP_RECORDER: SdkCallRecorder = {
    async record() {
        // intentional no-op
    },
};
