import { createHmac } from "node:crypto";
import { type Logger, logger } from "@autonoma/logger";
import type { DiscoverResponse, DownResponse, UpResponse } from "@autonoma/types";
import { DiscoverResponseSchema, DownResponseSchema, UpResponseSchema } from "@autonoma/types";
import type { z } from "zod";
import { NOOP_RECORDER, type SdkAction, type SdkCallRecorder } from "./sdk-call-recorder";
import { SdkHttpError } from "./sdk-http-error";

export interface SdkCallOptions {
    timeoutMs?: number;
}

/**
 * Cap on how much of a non-JSON response body we preserve. Customer endpoints
 * that error out often return a full HTML page (framework error page, proxy/CDN
 * 500, auth wall); we keep enough to identify the source without bloating the
 * `WebhookCall` row.
 */
const MAX_RAW_BODY_CHARS = 4_000;

export interface SdkClientOptions {
    applicationId: string;
    sdkUrl: string;
    signingSecret: string;
    customHeaders?: Record<string, string>;
    recorder?: SdkCallRecorder;
}

interface UpParams {
    instanceId: string;
    create: Record<string, unknown>;
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
            throw new SdkHttpError(status, message, detail);
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

        const rawText = await response.text();
        return { status: response.status, responseBody: parseResponseBody(rawText, response.headers) };
    }
}

function sign(body: string, signingSecret: string): string {
    return createHmac("sha256", signingSecret).update(body).digest("hex");
}

/**
 * Parse a response body as JSON, preserving the raw payload when it is not valid
 * JSON. A non-JSON body (e.g. an HTML error page) is the single most useful
 * artifact for debugging a failed customer endpoint, so on parse failure we keep
 * the raw text (truncated) and the declared content type instead of discarding
 * them - both land in the recorded `WebhookCall.responseBody`.
 */
function parseResponseBody(rawText: string, headers: Headers): unknown {
    try {
        return JSON.parse(rawText);
    } catch (error) {
        return {
            error: `Error parsing response: ${error instanceof Error ? error.message : String(error)}`,
            contentType: headers.get("content-type") ?? undefined,
            rawBody: rawText.slice(0, MAX_RAW_BODY_CHARS),
        };
    }
}

function extractResponseDetail(responseBody: unknown): string | undefined {
    if (responseBody == null || typeof responseBody !== "object") return undefined;
    const body = responseBody as Record<string, unknown>;
    const detail = body.message ?? body.error ?? body.detail;
    if (detail != null) {
        if (typeof detail === "string") {
            const trimmed = detail.trim();
            if (trimmed.length > 0) return trimmed;
        } else {
            return JSON.stringify(detail);
        }
    }

    const code = body.code;
    if (typeof code === "string" && code.trim().length > 0) {
        return `code=${code.trim()} - the SDK endpoint returned an empty error message; check the preview app runtime logs`;
    }
    return undefined;
}
