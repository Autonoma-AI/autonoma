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
     * Creates an ExternalSecret CR in the namespace for the repo's registered AWS secret.
     * The secret is shared across all apps in the deployment - returns a map of
     * appName -> k8sSecretName so the deployer can wire envFrom on each deployment.
     */
    async applyForNamespace(
        organizationId: string,
        namespace: string,
        githubRepositoryId: number,
        appNames: string[],
    ): Promise<Map<string, string>> {
        this.logger.info("Applying AWS ExternalSecrets for namespace", {
            organizationId,
            namespace,
            githubRepositoryId,
            appNames,
        });

        const record = await this.prisma.previewkitSecret.findFirst({
            where: {
                application: {
                    organizationId,
                    githubRepositoryId,
                },
            },
        });

        const result = new Map<string, string>();

        if (record == null) {
            this.logger.info("No AWS ExternalSecret registered for repo", { githubRepositoryId, namespace });
            return result;
        }

        const resource = this.buildExternalSecret(record, namespace, organizationId);
        await this.applyExternalSecret(namespace, resource);

        for (const appName of appNames) {
            result.set(appName, record.k8sSecretName);
        }

        this.logger.info("AWS ExternalSecrets applied", {
            githubRepositoryId,
            k8sSecretName: record.k8sSecretName,
            awsSecretArn: record.awsSecretArn,
            appCount: appNames.length,
            namespace,
        });

        return result;
    }

    private buildExternalSecret(
        record: { id: string; awsSecretArn: string; k8sSecretName: string },
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
                    name: record.k8sSecretName,
                    creationPolicy: "Owner",
                },
                dataFrom: [{ extract: { key: record.awsSecretArn } }],
            },
        };
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
