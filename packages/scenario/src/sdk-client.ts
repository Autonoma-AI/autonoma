import { createHmac } from "node:crypto";
import { type Logger, logger } from "@autonoma/logger";
import type { DiscoverResponse, DownResponse, UpResponse } from "@autonoma/types";
import { DiscoverResponseSchema, DownResponseSchema, UpResponseSchema } from "@autonoma/types";
import type { z } from "zod";
import { NOOP_RECORDER, type SdkAction, type SdkCallRecorder } from "./sdk-call-recorder";

export interface SdkCallOptions {
    timeoutMs?: number;
}

export interface SdkClientOptions {
    applicationId: string;
    sdkUrl: string;
    signingSecret: string;
    customHeaders?: Record<string, string>;
    recorder?: SdkCallRecorder;
}

interface UpParams {
    instanceId: string;
    create: Record<string, unknown[]>;
}

interface DownParams {
    instanceId: string;
    refs: Record<string, unknown> | null;
    refsToken?: string;
}

interface CallParams<T> {
    instanceId?: string;
    action: SdkAction;
    body: unknown;
    responseSchema: z.ZodType<T>;
    timeoutMs: number;
}

/**
 * HMAC-signed HTTP client for the customer-deployed Autonoma SDK endpoint.
 *
 * Pure: no database, no global state. The optional `recorder` is the only
 * observability seam - inject `DbSdkCallRecorder` in production to persist
 * call rows, or pass nothing in tests.
 *
 * Each method performs a single request (no retries). A failed call surfaces
 * as a thrown error for the caller to handle.
 */
export class SdkClient {
    private readonly logger: Logger;
    private readonly applicationId: string;
    private readonly sdkUrl: string;
    private readonly signingSecret: string;
    private readonly customHeaders: Record<string, string>;
    private readonly recorder: SdkCallRecorder;

    constructor(options: SdkClientOptions) {
        this.applicationId = options.applicationId;
        this.sdkUrl = options.sdkUrl;
        this.signingSecret = options.signingSecret;
        this.customHeaders = options.customHeaders ?? {};
        this.recorder = options.recorder ?? NOOP_RECORDER;
        this.logger = logger.child({ name: this.constructor.name, applicationId: this.applicationId });
    }

    async discover(options?: SdkCallOptions): Promise<DiscoverResponse> {
        return this.call({
            action: "DISCOVER",
            body: { action: "discover" },
            responseSchema: DiscoverResponseSchema,
            timeoutMs: options?.timeoutMs ?? 90_000,
        });
    }

    async up({ instanceId, create }: UpParams, options?: SdkCallOptions): Promise<UpResponse> {
        return this.call({
            instanceId,
            action: "UP",
            body: { action: "up", create, testRunId: instanceId },
            responseSchema: UpResponseSchema,
            timeoutMs: options?.timeoutMs ?? 90_000,
        });
    }

    async down({ instanceId, refs, refsToken }: DownParams, options?: SdkCallOptions): Promise<DownResponse> {
        return this.call({
            instanceId,
            action: "DOWN",
            body: { action: "down", refs, refsToken, testRunId: instanceId },
            responseSchema: DownResponseSchema,
            timeoutMs: options?.timeoutMs ?? 60_000,
        });
    }

    private async call<T>(params: CallParams<T>): Promise<T> {
        const { instanceId, action, body, responseSchema, timeoutMs } = params;

        const startTime = Date.now();
        let response: { status: number; responseBody: unknown };
        try {
            response = await this.executeRequest(body, timeoutMs);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            const isTimeout = error.name === "TimeoutError" || error.name === "AbortError";
            const message = isTimeout
                ? `SDK call timed out after ${timeoutMs / 1000}s - ensure your endpoint is reachable and responds quickly`
                : error.message;
            await this.recorder.record({
                applicationId: this.applicationId,
                instanceId,
                action,
                requestBody: body,
                durationMs: Date.now() - startTime,
                error: message,
            });
            this.logger.warn(`SDK ${action} failed`, { error: message });
            throw new Error(message);
        }

        const { status, responseBody } = response;
        await this.recorder.record({
            applicationId: this.applicationId,
            instanceId,
            action,
            requestBody: body,
            responseBody,
            statusCode: status,
            durationMs: Date.now() - startTime,
        });

        if (status < 200 || status >= 300) {
            const detail = extractResponseDetail(responseBody);
            const message = detail != null ? `SDK returned HTTP ${status}: ${detail}` : `SDK returned HTTP ${status}`;
            this.logger.warn(`SDK ${action} returned ${status}`, { status, responseBody });
            throw new Error(message);
        }

        const parsed = responseSchema.safeParse(responseBody);
        if (!parsed.success) {
            throw new Error(`SDK ${action} response validation failed: ${parsed.error.message}`);
        }
        return parsed.data;
    }

    private async executeRequest(body: unknown, timeoutMs: number): Promise<{ status: number; responseBody: unknown }> {
        const bodyString = JSON.stringify(body);
        const signature = sign(bodyString, this.signingSecret);

        const response = await fetch(this.sdkUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-signature": signature,
                ...this.customHeaders,
            },
            body: bodyString,
            signal: AbortSignal.timeout(timeoutMs),
        });

        const responseBody = await response.json().catch((error: unknown) => ({
            error: `Error parsing response: ${error instanceof Error ? error.message : String(error)}`,
        }));
        return { status: response.status, responseBody };
    }
}

function sign(body: string, signingSecret: string): string {
    return createHmac("sha256", signingSecret).update(body).digest("hex");
}

function extractResponseDetail(responseBody: unknown): string | undefined {
    if (responseBody == null || typeof responseBody !== "object") return undefined;
    const body = responseBody as Record<string, unknown>;
    const detail = body.message ?? body.error ?? body.detail;
    if (detail == null) return undefined;
    return typeof detail === "string" ? detail : JSON.stringify(detail);
}
