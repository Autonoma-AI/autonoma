import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AmpRequestSender } from "./amp-request-sender";

const AMP_SERVICE_NAME = "aps";
const QUERY_PATH = "/api/v1/query";
const QUERY_TIMEOUT_MS = 30_000;

/**
 * Signs and sends PromQL instant queries against an Amazon Managed Prometheus
 * workspace's `/api/v1/query` endpoint using SigV4 (`aps:QueryMetrics`) and the
 * default AWS credential provider chain (EKS Pod Identity in-cluster). There is
 * no dedicated AWS SDK client for the AMP *query* API - only for its control
 * plane - so this signs a plain HTTPS request by hand, the same shape as the
 * `curl --aws-sigv4` recipe in deployment/amp/README.md.
 */
export class SigV4AmpRequestSender implements AmpRequestSender {
    private readonly signer: SignatureV4;
    private readonly url: URL;

    constructor(workspaceUrl: string, region: string) {
        this.url = new URL(`${workspaceUrl}${QUERY_PATH}`);
        this.signer = new SignatureV4({
            credentials: fromNodeProviderChain(),
            region,
            service: AMP_SERVICE_NAME,
            sha256: Hash.bind(null, "sha256"),
        });
    }

    async send(query: string, time: Date): Promise<unknown> {
        const body = new URLSearchParams({ query, time: String(time.getTime() / 1000) }).toString();

        const request = new HttpRequest({
            method: "POST",
            protocol: this.url.protocol,
            hostname: this.url.hostname,
            path: this.url.pathname,
            headers: {
                host: this.url.hostname,
                "content-type": "application/x-www-form-urlencoded",
            },
            body,
        });

        const signed = await this.signer.sign(request);

        // `signed.headers` includes the `host` header SigV4 signed over. fetch()
        // silently drops it (Host is a forbidden header) and sets its own from
        // `this.url` instead - safe here only because the two are identical (the
        // request was built from `this.url` in the first place).
        const res = await fetch(this.url, {
            method: signed.method,
            headers: signed.headers,
            body: signed.body,
            signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });

        if (!res.ok) {
            throw new Error(`AMP query failed with status ${res.status}: ${await res.text()}`);
        }

        return res.json();
    }
}
