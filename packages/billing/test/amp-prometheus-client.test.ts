import { describe, expect, test } from "vitest";
import { AmpPrometheusClient } from "../src/preview-usage-meter/amp-prometheus-client";
import { FakeAmpRequestSender } from "./fake-amp-request-sender";

describe("AmpPrometheusClient", () => {
    test("queries vCPU-seconds by namespace and parses the vector response", async () => {
        const sender = new FakeAmpRequestSender();
        const windowEnd = new Date("2026-07-21T12:15:00.000Z");
        sender.respondAt(windowEnd, {
            cpu: [
                { namespace: "preview-acme-web-pr-1", value: 12.5 },
                { namespace: "preview-acme-web-pr-2", value: 0 },
            ],
        });

        const client = new AmpPrometheusClient(sender);
        const result = await client.queryVcpuSecondsByNamespace(windowEnd);

        expect(result.get("preview-acme-web-pr-1")).toBe(12.5);
        expect(result.get("preview-acme-web-pr-2")).toBe(0);
        expect(result.has("preview-acme-web-pr-3")).toBe(false);

        expect(sender.calls).toHaveLength(1);
        expect(sender.calls[0]?.query).toContain("container_cpu_usage_seconds_total");
        expect(sender.calls[0]?.query).toContain('namespace=~"preview-.+"');
        expect(sender.calls[0]?.query).toContain("increase(");
    });

    test("queries average memory GB by namespace with the byte-to-GB division in the query", async () => {
        const sender = new FakeAmpRequestSender();
        const windowEnd = new Date("2026-07-21T12:30:00.000Z");
        sender.respondAt(windowEnd, { memory: [{ namespace: "preview-acme-web-pr-1", value: 0.5 }] });

        const client = new AmpPrometheusClient(sender);
        const result = await client.queryAverageGbByNamespace(windowEnd);

        expect(result.get("preview-acme-web-pr-1")).toBe(0.5);
        expect(sender.calls[0]?.query).toContain("container_memory_working_set_bytes");
        expect(sender.calls[0]?.query).toContain("avg_over_time(");
        expect(sender.calls[0]?.query).toContain("/ 1073741824");
    });

    test("returns an empty map when the window has no samples", async () => {
        const sender = new FakeAmpRequestSender();
        const windowEnd = new Date("2026-07-21T12:45:00.000Z");
        // No respondAt call configured for this window - defaults to an empty result vector.

        const client = new AmpPrometheusClient(sender);
        const result = await client.queryVcpuSecondsByNamespace(windowEnd);

        expect(result.size).toBe(0);
    });

    test("throws on an AMP error response", async () => {
        const sender = new FakeAmpRequestSender();
        const windowEnd = new Date("2026-07-21T13:00:00.000Z");
        sender.respondAt(windowEnd, { cpu: "error" });

        const client = new AmpPrometheusClient(sender);
        await expect(client.queryVcpuSecondsByNamespace(windowEnd)).rejects.toThrow(/AMP query error/);
    });

    test("throws on a response that doesn't match the expected shape", async () => {
        const sender = { send: async () => ({ unexpected: true }) };
        const client = new AmpPrometheusClient(sender);

        await expect(client.queryVcpuSecondsByNamespace(new Date())).rejects.toThrow(/unexpected response shape/);
    });
});
