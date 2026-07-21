import { z } from "zod";
import { Service } from "../service";
import type { AmpRequestSender } from "./amp-request-sender";

const NAMESPACE_LABEL_PATTERN = "preview-.+";
const BYTES_PER_GB = 1024 * 1024 * 1024;

const PrometheusQuerySuccessSchema = z.object({
    status: z.literal("success"),
    data: z.object({
        resultType: z.literal("vector"),
        result: z.array(
            z.object({
                metric: z.record(z.string(), z.string()),
                value: z.tuple([z.number(), z.string()]),
            }),
        ),
    }),
});

const PrometheusQueryErrorSchema = z.object({
    status: z.literal("error"),
    errorType: z.string().optional(),
    error: z.string().optional(),
});

const PrometheusQueryResponseSchema = z.union([PrometheusQuerySuccessSchema, PrometheusQueryErrorSchema]);

/**
 * Query helper for the two previewkit compute-billing series (vCPU-seconds and
 * average memory GB), scoped to `namespace=~"preview-.+"` on the previewkit
 * cluster. Both queries are grouped `by (namespace)` so one call prices the
 * whole fleet at once, regardless of how many environments are due.
 */
export class AmpPrometheusClient extends Service {
    constructor(private readonly sender: AmpRequestSender) {
        super();
    }

    /** vCPU-seconds consumed per namespace over the 15 minutes ending at `windowEnd`. */
    async queryVcpuSecondsByNamespace(windowEnd: Date): Promise<Map<string, number>> {
        const query =
            `sum by (namespace) (increase(container_cpu_usage_seconds_total` +
            `{cluster="previewkit", namespace=~"${NAMESPACE_LABEL_PATTERN}", container!=""}[15m]))`;
        return this.queryByNamespace(query, windowEnd);
    }

    /** Average memory GB over the 15 minutes ending at `windowEnd`, per namespace - callers multiply by window seconds for GB-seconds. */
    async queryAverageGbByNamespace(windowEnd: Date): Promise<Map<string, number>> {
        const query =
            `sum by (namespace) (avg_over_time(container_memory_working_set_bytes` +
            `{cluster="previewkit", namespace=~"${NAMESPACE_LABEL_PATTERN}", container!=""}[15m])) / ${BYTES_PER_GB}`;
        return this.queryByNamespace(query, windowEnd);
    }

    private async queryByNamespace(query: string, time: Date): Promise<Map<string, number>> {
        this.logger.info("Querying AMP", { query, time });

        const raw = await this.sender.send(query, time);
        const parsed = PrometheusQueryResponseSchema.safeParse(raw);

        if (!parsed.success) {
            throw new Error(`AMP query returned an unexpected response shape: ${parsed.error.message}`);
        }

        if (parsed.data.status === "error") {
            throw new Error(`AMP query error: ${parsed.data.errorType ?? "unknown"} - ${parsed.data.error ?? ""}`);
        }

        const byNamespace = new Map<string, number>();
        for (const sample of parsed.data.data.result) {
            const namespace = sample.metric.namespace;
            if (namespace == null) continue;
            byNamespace.set(namespace, Number(sample.value[1]));
        }

        this.logger.info("AMP query complete", { query, namespaceCount: byNamespace.size });
        return byNamespace;
    }
}
