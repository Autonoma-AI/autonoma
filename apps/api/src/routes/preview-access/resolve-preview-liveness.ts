import { EksKubeconfigLoader } from "@autonoma/k8s/eks";
import { type NamespaceLiveness, PreviewFleetClient } from "@autonoma/k8s/preview-liveness";
import { logger } from "@autonoma/logger";
import { env } from "../../env";
import { type FleetSource, PreviewLivenessService } from "./preview-liveness.service";

// The STS-presigned EKS token lasts 60s; refresh it well inside that window so a
// long-lived API pod never presents an expired one. The loader mutates its
// KubeConfig in place, and the fleet client re-reads it per request.
const EKS_TOKEN_REFRESH_INTERVAL_MS = 30_000;

let resolved = false;
let service: PreviewLivenessService | undefined;

/**
 * The preview-liveness service, or undefined when the feature is not configured.
 * Built once and memoized. Disabled (returns undefined) unless the preview
 * cluster's name and an AWS region are set, so any environment without
 * cross-cluster reach simply never constructs a Kubernetes client - callers then
 * report "unknown".
 */
export function resolvePreviewLivenessService(): PreviewLivenessService | undefined {
    if (resolved) return service;
    resolved = true;

    if (env.PREVIEWKIT_EKS_CLUSTER_NAME == null || env.AWS_REGION == null) {
        // Nothing enforces these at boot: previews build without cross-cluster reach, only liveness needs it.
        // Warn rather than info - in a deployment that serves previews this is a misconfiguration, and the
        // symptom (every preview reporting "unknown") does not name its cause.
        logger.warn("Preview liveness unavailable: PREVIEWKIT_EKS_CLUSTER_NAME or AWS_REGION is unset");
        return undefined;
    }

    const staticClusterInfo =
        env.PREVIEWKIT_EKS_CLUSTER_ENDPOINT != null && env.PREVIEWKIT_EKS_CLUSTER_CA != null
            ? { endpoint: env.PREVIEWKIT_EKS_CLUSTER_ENDPOINT, caData: env.PREVIEWKIT_EKS_CLUSTER_CA }
            : undefined;
    const loader = new EksKubeconfigLoader(env.PREVIEWKIT_EKS_CLUSTER_NAME, env.AWS_REGION, staticClusterInfo);
    logger.info("Preview liveness enabled", { extra: { cluster: env.PREVIEWKIT_EKS_CLUSTER_NAME } });

    service = new PreviewLivenessService(new EksFleetSource(loader));
    return service;
}

/**
 * A FleetSource backed by the cross-cluster EKS client. The client is built
 * lazily on first read (the token mint is async and must stay out of the sync
 * resolver) and memoized, and a background timer keeps its token fresh.
 */
class EksFleetSource implements FleetSource {
    private clientPromise?: Promise<PreviewFleetClient>;

    constructor(private readonly loader: EksKubeconfigLoader) {}

    async listFleet(): Promise<Map<string, NamespaceLiveness>> {
        const client = await this.ensureClient();
        return await client.listFleet();
    }

    private ensureClient(): Promise<PreviewFleetClient> {
        // Do NOT cache a rejected build. A rejected promise is not nullish, so a
        // single transient STS/EKS failure (and the refresh timer, which is only
        // armed after the load succeeds) would otherwise be pinned for the whole
        // process lifetime with no self-healing. Clear it on failure so the next
        // read retries.
        this.clientPromise ??= this.buildClient().catch((err: unknown) => {
            this.clientPromise = undefined;
            throw err;
        });
        return this.clientPromise;
    }

    private async buildClient(): Promise<PreviewFleetClient> {
        const kubeConfig = await this.loader.load();
        const timer = setInterval(() => {
            this.loader.refresh().catch((err: unknown) => logger.error("EKS token refresh failed", { extra: { err } }));
        }, EKS_TOKEN_REFRESH_INTERVAL_MS);
        timer.unref();
        return new PreviewFleetClient(kubeConfig);
    }
}
