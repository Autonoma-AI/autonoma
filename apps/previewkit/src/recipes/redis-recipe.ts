import type * as k8s from "@kubernetes/client-node";
import type { ServiceConfig } from "../config/schema";
import type { Recipe, RecipeResources, RecipeConnectionInfo } from "./recipe";

const DEFAULT_VERSION = "7-alpine";
const PORT = 6379;

export class RedisRecipe implements Recipe {
    readonly name = "redis";

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        return { host: config.name, port: PORT };
    }

    generate(config: ServiceConfig, namespace: string): RecipeResources {
        const version = config.version ?? DEFAULT_VERSION;
        const image = `redis:${version}`;
        const labels = {
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": config.name,
        };

        const deployment: k8s.V1Deployment = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: {
                name: config.name,
                namespace,
                labels,
            },
            spec: {
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
                                env: Object.entries(config.env).map(([name, value]) => ({
                                    name,
                                    value,
                                })),
                                resources: {
                                    requests: {
                                        cpu: config.resources.cpu,
                                        memory: config.resources.memory,
                                    },
                                    limits: {
                                        memory: config.resources.memory,
                                    },
                                },
                                readinessProbe: {
                                    exec: {
                                        command: ["redis-cli", "ping"],
                                    },
                                    initialDelaySeconds: 3,
                                    periodSeconds: 5,
                                },
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
            deployments: [deployment],
            statefulSets: [],
            services: [service],
            configMaps: [],
            persistentVolumeClaims: [],
        };
    }
}
