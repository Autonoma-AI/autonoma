import type { QuerySender } from "./query-sender";

const QUERY_PATH = "/api/v1/query";
const QUERY_TIMEOUT_MS = 30_000;

export interface PrometheusCredentials {
    username: string;
    password: string;
}

/**
 * Sends PromQL instant queries to the self-hosted Prometheus's `/api/v1/query`
 * endpoint over TLS with HTTP basic auth - the same credential the in-cluster
 * scrape agents remote_write with (deployment/prometheus-agent/README.md).
 */
export class HttpQuerySender implements QuerySender {
    private readonly url: URL;
    private readonly authorization: string;

    constructor(prometheusUrl: string, credentials: PrometheusCredentials) {
        this.url = new URL(QUERY_PATH, prometheusUrl);
        const encoded = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");
        this.authorization = `Basic ${encoded}`;
    }

    async send(query: string, time: Date): Promise<unknown> {
        const body = new URLSearchParams({ query, time: String(time.getTime() / 1000) }).toString();

        const res = await fetch(this.url, {
            method: "POST",
            headers: {
                authorization: this.authorization,
                "content-type": "application/x-www-form-urlencoded",
            },
            body,
            signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });

        if (!res.ok) {
            throw new Error(`Prometheus query failed with status ${res.status}: ${await res.text()}`);
        }

        return res.json();
    }
}
