import { db, type PrismaClient } from "@autonoma/db";
import * as k8s from "@kubernetes/client-node";
import { isConflict } from "../deployer/k8s-errors";
import { type Logger, logger as rootLogger } from "../logger";

const LABEL_MANAGED_BY = "previewkit.dev/managed-by";
const LABEL_TYPE = "previewkit.dev/type";
const LABEL_ORG = "previewkit.dev/org";

const ESO_GROUP = "external-secrets.io";
const ESO_VERSION = "v1";
const ESO_PLURAL = "externalsecrets";

interface ExternalSecret {
    apiVersion: "external-secrets.io/v1";
    kind: "ExternalSecret";
    metadata: {
        name: string;
        namespace: string;
        labels: Record<string, string>;
    };
    spec: {
        refreshInterval: string;
        secretStoreRef: { name: string; kind: "ClusterSecretStore" };
        target: { name: string; creationPolicy: "Owner" };
        dataFrom: Array<{ extract: { key: string } }>;
    };
}

export class AwsExternalSecretManager {
    private readonly customApi: k8s.CustomObjectsApi;
    private readonly logger: Logger;

    constructor(
        kc: k8s.KubeConfig,
        private readonly clusterSecretStoreName: string,
        private readonly prisma: PrismaClient = db,
    ) {
        this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Creates one ExternalSecret CR per (app, AWS-SM-ARN) pair registered for
     * this Application. Each app's secret is independently IAM-scoped — adding
     * a new app to the monorepo requires registering its own PreviewkitSecret
     * row pointing at its own AWS SM ARN.
     *
     * Returns appName → k8sSecretName for the apps that have a registered
     * secret, so the deployer can wire `envFrom` per Deployment. Apps without
     * a registered secret are simply absent from the map.
     */
    async applyForNamespace(
        organizationId: string,
        namespace: string,
        appNames: string[],
    ): Promise<Map<string, string>> {
        this.logger.info("Applying AWS ExternalSecrets for namespace", {
            organizationId,
            namespace,
            appNames,
        });

        // Filter only by organizationId + appName, not by githubRepositoryId.
        // In multirepo deployments, apps from different repos (each with their
        // own Application and githubRepositoryId) are deployed into the same
        // namespace. Filtering by a single githubRepositoryId would silently
        // skip secrets registered for apps from the other repos.
        const records = await this.prisma.previewkitSecret.findMany({
            where: {
                application: { organizationId },
                appName: { in: appNames },
            },
        });

        const result = new Map<string, string>();

        if (records.length === 0) {
            this.logger.info("No AWS ExternalSecrets registered for any of the listed apps", {
                namespace,
                appNames,
            });
            return result;
        }

        for (const record of records) {
            // K8s Secret name is derived from appName locally — see toK8sName().
            // The previewkit_secret row no longer persists it.
            const k8sSecretName = this.toK8sName(record.appName);
            const resource = this.buildExternalSecret(record, k8sSecretName, namespace, organizationId);
            await this.applyExternalSecret(namespace, resource);
            result.set(record.appName, k8sSecretName);

            this.logger.info("Applied AWS ExternalSecret", {
                appName: record.appName,
                k8sSecretName,
                awsSecretArn: record.awsSecretArn,
                namespace,
            });
        }

        this.logger.info("AWS ExternalSecrets applied", {
            appliedCount: result.size,
            requestedCount: appNames.length,
            namespace,
        });

        return result;
    }

    private buildExternalSecret(
        record: { id: string; awsSecretArn: string },
        k8sSecretName: string,
        namespace: string,
        organizationId: string,
    ): ExternalSecret {
        return {
            apiVersion: "external-secrets.io/v1",
            kind: "ExternalSecret",
            metadata: {
                name: `previewkit-aws-${record.id}`,
                namespace,
                labels: {
                    [LABEL_MANAGED_BY]: "previewkit",
                    [LABEL_TYPE]: "aws-external-secret",
                    [LABEL_ORG]: organizationId,
                },
            },
            spec: {
                refreshInterval: "1h",
                secretStoreRef: {
                    name: this.clusterSecretStoreName,
                    kind: "ClusterSecretStore",
                },
                target: {
                    name: k8sSecretName,
                    creationPolicy: "Owner",
                },
                dataFrom: [{ extract: { key: record.awsSecretArn } }],
            },
        };
    }

    /**
     * Derive the K8s Secret name that External Secrets Operator materialises
     * in the preview namespace from the inner app's name. The per-PR namespace
     * already provides isolation, so `<appName>-secrets` is unique without any
     * further scoping. Mirrors the rules `previewkit.dev/managed-by` k8s names
     * follow: lowercase alnum + hyphens, trimmed, capped under the 63-char
     * label limit (55 + `-secrets` suffix = 63).
     */
    private toK8sName(appName: string): string {
        return appName
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 55)
            .concat("-secrets");
    }

    private async applyExternalSecret(namespace: string, resource: ExternalSecret): Promise<void> {
        const name = resource.metadata.name;
        try {
            await this.customApi.createNamespacedCustomObject({
                group: ESO_GROUP,
                version: ESO_VERSION,
                namespace,
                plural: ESO_PLURAL,
                body: resource,
            });
        } catch (err: unknown) {
            if (!isConflict(err)) throw err;

            const existing = (await this.customApi.getNamespacedCustomObject({
                group: ESO_GROUP,
                version: ESO_VERSION,
                namespace,
                plural: ESO_PLURAL,
                name,
            })) as { metadata?: { resourceVersion?: string } };

            await this.customApi.replaceNamespacedCustomObject({
                group: ESO_GROUP,
                version: ESO_VERSION,
                namespace,
                plural: ESO_PLURAL,
                name,
                body: {
                    ...resource,
                    metadata: {
                        ...resource.metadata,
                        resourceVersion: existing.metadata?.resourceVersion,
                    },
                },
            });
        }
    }
}
