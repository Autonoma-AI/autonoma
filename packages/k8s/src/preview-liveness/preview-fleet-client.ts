import { logger as rootLogger, type Logger } from "@autonoma/logger";
import { AppsV1Api, CoreV1Api, type KubeConfig } from "@kubernetes/client-node";
import { classifyNamespace, PREVIEW_MANAGED_LABEL_SELECTOR } from "./classify";
import type { NamespaceLiveness } from "./types";

/**
 * Reads preview power/health state straight from the preview cluster's
 * Kubernetes API - the source of truth the Gatekeeper scales against. Three
 * cluster-wide LISTs (Deployments, StatefulSets, Pods) filtered to the managed
 * label describe the whole fleet in one round trip.
 *
 * Strictly READ-ONLY: it never scales anything, so - unlike an HTTP probe
 * through the Gatekeeper - reading a preview's state never wakes it. Safe to
 * poll behind a list view.
 */
export class PreviewFleetClient {
    private readonly logger: Logger;
    private readonly appsApi: AppsV1Api;
    private readonly coreApi: CoreV1Api;

    constructor(kubeConfig: KubeConfig) {
        this.logger = rootLogger.child({ name: "PreviewFleetClient" });
        // Built once from the KubeConfig reference. EksKubeconfigLoader mutates
        // that same reference in place on token refresh, and the clients re-read
        // its user per request, so they pick up fresh credentials automatically.
        this.appsApi = kubeConfig.makeApiClient(AppsV1Api);
        this.coreApi = kubeConfig.makeApiClient(CoreV1Api);
    }

    /**
     * Every managed preview namespace mapped to its derived liveness. A namespace
     * appears only if it has at least one managed workload.
     */
    async listFleet(): Promise<Map<string, NamespaceLiveness>> {
        this.logger.info("Listing preview fleet liveness");

        const [deployments, statefulSets, pods] = await Promise.all([
            this.appsApi.listDeploymentForAllNamespaces({ labelSelector: PREVIEW_MANAGED_LABEL_SELECTOR }),
            this.appsApi.listStatefulSetForAllNamespaces({ labelSelector: PREVIEW_MANAGED_LABEL_SELECTOR }),
            this.coreApi.listPodForAllNamespaces({ labelSelector: PREVIEW_MANAGED_LABEL_SELECTOR }),
        ]);

        const deploymentsByNs = groupByNamespace(deployments.items);
        const statefulSetsByNs = groupByNamespace(statefulSets.items);
        const podsByNs = groupByNamespace(pods.items);

        const namespaces = new Set([...deploymentsByNs.keys(), ...statefulSetsByNs.keys()]);
        const fleet = new Map<string, NamespaceLiveness>();
        for (const namespace of namespaces) {
            fleet.set(
                namespace,
                classifyNamespace({
                    namespace,
                    deployments: deploymentsByNs.get(namespace) ?? [],
                    statefulSets: statefulSetsByNs.get(namespace) ?? [],
                    pods: podsByNs.get(namespace) ?? [],
                }),
            );
        }

        this.logger.info("Listed preview fleet liveness", {
            extra: { namespaces: fleet.size, deployments: deployments.items.length, pods: pods.items.length },
        });
        return fleet;
    }
}

function groupByNamespace<T extends { metadata?: { namespace?: string } }>(items: T[]): Map<string, T[]> {
    const byNamespace = new Map<string, T[]>();
    for (const item of items) {
        const namespace = item.metadata?.namespace;
        if (namespace == null) continue;
        const bucket = byNamespace.get(namespace);
        if (bucket == null) {
            byNamespace.set(namespace, [item]);
        } else {
            bucket.push(item);
        }
    }
    return byNamespace;
}
