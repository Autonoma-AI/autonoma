import type * as k8s from "@kubernetes/client-node";
import type { ServiceConfig } from "../config/schema";
import type { Recipe, RecipeResources, RecipeConnectionInfo } from "./recipe";

const DEFAULT_VERSION = "16-alpine";
const PORT = 5432;

export class PostgresRecipe implements Recipe {
    readonly name = "postgres";

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        return { host: config.name, port: PORT };
    }

    generate(config: ServiceConfig, namespace: string): RecipeResources {
        const version = config.version ?? DEFAULT_VERSION;
        const image = `postgres:${version}`;
        const labels = {
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": config.name,
        };

        const pvc: k8s.V1PersistentVolumeClaim = {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: {
                name: `${config.name}-data`,
                namespace,
                labels,
            },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                    requests: { storage: "1Gi" },
                },
            },
        };

        const statefulSet: k8s.V1StatefulSet = {
            apiVersion: "apps/v1",
            kind: "StatefulSet",
            metadata: {
                name: config.name,
                namespace,
                labels,
            },
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
                                    { name: "POSTGRES_USER", value: "preview" },
                                    { name: "POSTGRES_PASSWORD", value: "preview" },
                                    { name: "POSTGRES_DB", value: "preview" },
                                    ...Object.entries(config.env).map(([name, value]) => ({
                                        name,
                                        value,
                                    })),
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
                                volumeMounts: [
                                    {
                                        name: "data",
                                        mountPath: "/var/lib/postgresql/data",
                                    },
                                ],
                                readinessProbe: {
                                    exec: {
                                        command: ["pg_isready", "-U", "preview"],
                                    },
                                    initialDelaySeconds: 5,
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
            metadata: {
                name: config.name,
                namespace,
                labels,
            },
            spec: {
                selector: { app: config.name },
                ports: [{ port: PORT, targetPort: PORT }],
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
