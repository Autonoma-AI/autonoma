import type * as k8s from "@kubernetes/client-node";
import type { ServiceConfig } from "../config/schema";
import { BaseRecipe, passthroughOptionsSchema, type RecipeConnectionInfo, type RecipeResources } from "./recipe";

const DEFAULT_VERSION = "8";
const PORT = 3306;
const DATA_MOUNT_PATH = "/var/lib/mysql";

// Standard preview credentials. Preview envs are throwaway and network-isolated,
// so the password is fixed; the user and database default to these values and
// are what the connection URL and readiness probe assume.
const MYSQL_ROOT_PASSWORD = "preview";
const MYSQL_USER = "preview";
const MYSQL_PASSWORD = "preview";
const MYSQL_DB = "preview";

/**
 * Single-node MySQL for preview environments. Mirrors the other database recipes:
 * a one-replica StatefulSet with a small PVC, fixed preview credentials, and a
 * readiness probe. The official `mysql` image seeds the user/database from the
 * `MYSQL_*` env on first boot.
 */
export class MysqlRecipe extends BaseRecipe {
    readonly name = "mysql";
    readonly schema = passthroughOptionsSchema;

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        return {
            host: config.name,
            port: PORT,
            url: `mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@${config.name}:${PORT}/${MYSQL_DB}`,
        };
    }

    typedGenerate(config: ServiceConfig, namespace: string): RecipeResources {
        const version = config.version ?? DEFAULT_VERSION;
        const image = `mysql:${version}`;
        const labels = {
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": config.name,
        };

        const pvc: k8s.V1PersistentVolumeClaim = {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: { name: `${config.name}-data`, namespace, labels },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage: "1Gi" } },
            },
        };

        const statefulSet: k8s.V1StatefulSet = {
            apiVersion: "apps/v1",
            kind: "StatefulSet",
            metadata: { name: config.name, namespace, labels },
            spec: {
                serviceName: config.name,
                replicas: 1,
                selector: { matchLabels: { app: config.name } },
                template: {
                    metadata: { labels: { app: config.name, ...labels } },
                    spec: {
                        containers: [
                            {
                                name: config.name,
                                image,
                                ports: [{ containerPort: PORT }],
                                env: [
                                    { name: "MYSQL_ROOT_PASSWORD", value: MYSQL_ROOT_PASSWORD },
                                    { name: "MYSQL_USER", value: MYSQL_USER },
                                    { name: "MYSQL_PASSWORD", value: MYSQL_PASSWORD },
                                    { name: "MYSQL_DATABASE", value: MYSQL_DB },
                                ],
                                resources: {
                                    requests: {
                                        cpu: config.resources.cpu,
                                        memory: config.resources.memory,
                                    },
                                    limits: {
                                        memory: config.resources.memory,
                                    },
                                },
                                volumeMounts: [{ name: "data", mountPath: DATA_MOUNT_PATH }],
                                readinessProbe: {
                                    exec: {
                                        command: ["mysqladmin", "ping", "-h", "127.0.0.1", `-p${MYSQL_ROOT_PASSWORD}`],
                                    },
                                    initialDelaySeconds: 10,
                                    periodSeconds: 5,
                                },
                            },
                        ],
                        volumes: [
                            {
                                name: "data",
                                persistentVolumeClaim: { claimName: `${config.name}-data` },
                            },
                        ],
                    },
                },
            },
        };

        const service: k8s.V1Service = {
            apiVersion: "v1",
            kind: "Service",
            metadata: { name: config.name, namespace, labels },
            spec: {
                selector: { app: config.name },
                ports: [{ port: PORT, targetPort: PORT, name: "mysql" }],
            },
        };

        return {
            deployments: [],
            statefulSets: [statefulSet],
            services: [service],
            configMaps: [],
            persistentVolumeClaims: [pvc],
        };
    }
}
