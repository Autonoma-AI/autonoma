import { logger as rootLogger, type Logger } from "@autonoma/logger";
import { CoreV1Api, type KubeConfig } from "@kubernetes/client-node";

/** A preview namespace as the reaper needs to see it. */
export interface PreviewNamespace {
    name: string;
    createdAt: Date;
}

/**
 * The cluster side of the reaper, kept to two operations so the sweep can be
 * tested against a real database and a stand-in cluster. A test that had to run
 * Kubernetes to prove "a row whose namespace is gone gets marked" would not be
 * worth writing, and that rule is the one carrying the risk.
 */
export interface PreviewNamespaces {
    /** Every `preview-*` namespace that currently exists. */
    list(): Promise<PreviewNamespace[]>;
    delete(name: string): Promise<void>;
}

/** Only namespaces the preview system owns; nothing else in the cluster is the reaper's business. */
const PREVIEW_NAMESPACE_PREFIX = "preview-";

export class ClusterPreviewNamespaces implements PreviewNamespaces {
    private readonly logger: Logger;
    private readonly coreApi: CoreV1Api;

    constructor(kubeConfig: KubeConfig) {
        this.logger = rootLogger.child({ name: this.constructor.name });
        this.coreApi = kubeConfig.makeApiClient(CoreV1Api);
    }

    async list(): Promise<PreviewNamespace[]> {
        const response = await this.coreApi.listNamespace();

        const namespaces = response.items.flatMap((item) => {
            const name = item.metadata?.name;
            const createdAt = item.metadata?.creationTimestamp;
            if (name == null || createdAt == null) return [];
            if (!name.startsWith(PREVIEW_NAMESPACE_PREFIX)) return [];
            return [{ name, createdAt: new Date(createdAt) }];
        });

        this.logger.info("Listed preview namespaces", { extra: { count: namespaces.length } });
        return namespaces;
    }

    async delete(name: string): Promise<void> {
        this.logger.info("Deleting preview namespace", { extra: { namespace: name } });
        await this.coreApi.deleteNamespace({ name });
    }
}
