import type * as k8s from "@kubernetes/client-node";
import type { ServiceConfig } from "../config/schema";
import { BaseRecipe, passthroughOptionsSchema, type RecipeConnectionInfo, type RecipeResources } from "./recipe";

// IMPORTANT: this repo's tag namespace is the Temporal *CLI* version
// (currently 1.7.x on Docker Hub), NOT the Temporal Server version (1.27.x).
// They're unrelated. Pinning to a CLI version like "1.27.x" or "1.29" will
// 404 — those aren't tags. Check https://hub.docker.com/r/temporalio/temporal
// before bumping.
const DEFAULT_VERSION = "1.7.0";
const GRPC_PORT = 7233;
const UI_PORT = 8233;

export class TemporalRecipe extends BaseRecipe {
    readonly name = "temporal";
    readonly schema = passthroughOptionsSchema;

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        return { host: config.name, port: GRPC_PORT };
    }

    typedGenerate(config: ServiceConfig, namespace: string): RecipeResources {
        const version = config.version ?? DEFAULT_VERSION;
        const image = `temporalio/temporal:${version}`;
        const labels = {
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": config.name,
        };

        const deployment: k8s.V1Deployment = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name: config.name, namespace, labels },
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
                                command: ["temporal"],
                                args: [
                                    "server",
                                    "start-dev",
                                    "--ip",
                                    "0.0.0.0",
                                    "--namespace",
                                    "default",
                                    "--port",
                                    String(GRPC_PORT),
                                    "--ui-port",
                                    String(UI_PORT),
                                ],
                                ports: [
                                    { name: "grpc", containerPort: GRPC_PORT },
                                    { name: "ui", containerPort: UI_PORT },
                                ],
                                resources: {
                                    requests: {
                                        cpu: "500m",
                                        memory: "512Mi",
                                    },
                                    limits: {
                                        memory: "1Gi",
                                    },
                                },
                                // `temporal server start-dev` takes a few seconds
                                // to come up. Probe the gRPC port; readiness flips
                                // once the frontend service binds.
                                readinessProbe: {
                                    tcpSocket: { port: GRPC_PORT },
                                    initialDelaySeconds: 5,
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
            metadata: { name: config.name, namespace, labels },
            spec: {
                selector: { app: config.name },
                ports: [
                    { name: "grpc", port: GRPC_PORT, targetPort: GRPC_PORT },
                    { name: "ui", port: UI_PORT, targetPort: UI_PORT },
                ],
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
