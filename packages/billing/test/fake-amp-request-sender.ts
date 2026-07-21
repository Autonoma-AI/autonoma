import type { AmpRequestSender } from "../src/preview-usage-meter/amp-request-sender";

export interface FakeAmpSample {
    namespace: string;
    value: number;
}

export interface FakeAmpCall {
    query: string;
    time: Date;
}

/**
 * Stands in for a real SigV4-signed AMP request in tests: returns canned
 * Prometheus `/api/v1/query` JSON instead of hitting the network, keyed by
 * whichever series (`cpu`/`memory`) the query string matches. Callers configure
 * per-window results via `respondAt`; a window with no configured response
 * returns an empty result vector (no samples).
 */
export class FakeAmpRequestSender implements AmpRequestSender {
    public readonly calls: FakeAmpCall[] = [];
    private readonly cpuByWindowEnd = new Map<number, FakeAmpSample[] | "error">();
    private readonly memoryByWindowEnd = new Map<number, FakeAmpSample[] | "error">();

    respondAt(windowEnd: Date, samples: { cpu?: FakeAmpSample[] | "error"; memory?: FakeAmpSample[] | "error" }): void {
        if (samples.cpu != null) this.cpuByWindowEnd.set(windowEnd.getTime(), samples.cpu);
        if (samples.memory != null) this.memoryByWindowEnd.set(windowEnd.getTime(), samples.memory);
    }

    async send(query: string, time: Date): Promise<unknown> {
        this.calls.push({ query, time });

        const isMemoryQuery = query.includes("container_memory_working_set_bytes");
        const configured = isMemoryQuery
            ? this.memoryByWindowEnd.get(time.getTime())
            : this.cpuByWindowEnd.get(time.getTime());

        if (configured === "error") {
            return { status: "error", errorType: "test_error", error: "simulated AMP failure" };
        }

        const samples = configured ?? [];
        return {
            status: "success",
            data: {
                resultType: "vector",
                result: samples.map((sample) => ({
                    metric: { namespace: sample.namespace },
                    value: [time.getTime() / 1000, String(sample.value)],
                })),
            },
        };
    }
}
