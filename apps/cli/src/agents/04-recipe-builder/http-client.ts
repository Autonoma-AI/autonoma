import { createHmac } from "node:crypto";

export interface SdkClientConfig {
    endpointUrl: string;
    sharedSecret: string;
    /** Abort the request after this many ms so a hung handler can't stall the caller. */
    timeoutMs?: number;
}

export interface SdkResponse {
    ok: boolean;
    status: number;
    body: unknown;
}

function sign(body: string, secret: string): string {
    return createHmac("sha256", secret).update(body).digest("hex");
}

async function sendRequest(config: SdkClientConfig, payload: unknown): Promise<SdkResponse> {
    const rawBody = JSON.stringify(payload);
    const signature = sign(rawBody, config.sharedSecret);

    const res = await fetch(config.endpointUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-signature": signature,
        },
        body: rawBody,
        signal: config.timeoutMs != null ? AbortSignal.timeout(config.timeoutMs) : undefined,
    });

    let body: unknown;
    const text = await res.text();
    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }

    return { ok: res.ok, status: res.status, body };
}

export async function discover(config: SdkClientConfig): Promise<SdkResponse> {
    return sendRequest(config, { action: "discover" });
}

export async function up(
    config: SdkClientConfig,
    create: Record<string, unknown[]>,
    testRunId: string,
): Promise<SdkResponse> {
    return sendRequest(config, {
        action: "up",
        testRunId,
        environment: "test",
        create,
    });
}

export async function down(config: SdkClientConfig, refsToken: string): Promise<SdkResponse> {
    return sendRequest(config, {
        action: "down",
        refsToken,
    });
}
