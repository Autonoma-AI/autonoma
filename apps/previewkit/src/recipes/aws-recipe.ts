import type * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { ServiceConfig } from "../config/schema";
import type { Recipe, RecipeConnectionInfo, RecipeResources } from "./recipe";

const DEFAULT_VERSION = "latest";
const PORT = 4566;

const optionsSchema = z.object({
    queues: z.array(z.string()).default([]),
    buckets: z.array(z.string()).default([]),
});

export class AwsRecipe implements Recipe {
    readonly name = "aws";

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        return { host: config.name, port: PORT };
    }

    generate(config: ServiceConfig, namespace: string): RecipeResources {
        const options = optionsSchema.parse(config.options);
        const enabledServices = buildServicesList(config);
        const version = config.version ?? DEFAULT_VERSION;
        const image = `ministackorg/ministack:${version}`;
        const labels = {
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": config.name,
        };

        const env: k8s.V1EnvVar[] = [
            { name: "SERVICES", value: enabledServices.join(",") },
            // Makes LocalStack advertise itself under the K8s service DNS name
            // so presigned URLs and SQS queue URLs resolve correctly within the cluster.
            { name: "LOCALSTACK_HOST", value: `${config.name}:${PORT}` },
            { name: "DEBUG", value: "0" },
            ...Object.entries(config.env).map(([name, value]) => ({ name, value })),
        ];

        const hasInit = options.queues.length > 0 || options.buckets.length > 0;
        const initConfigMapName = `${config.name}-init`;

        const container: k8s.V1Container = {
            name: config.name,
            image,
            ports: [{ containerPort: PORT }],
            env,
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
                httpGet: {
                    path: "/_localstack/health",
                    port: PORT,
                },
                initialDelaySeconds: 5,
                periodSeconds: 5,
                failureThreshold: 10,
            },
        };

        if (hasInit) {
            container.volumeMounts = [
                {
                    name: "localstack-init",
                    mountPath: "/etc/localstack/init/ready.d",
                },
            ];
        }

        const podSpec: k8s.V1PodSpec = { containers: [container] };
        if (hasInit) {
            podSpec.volumes = [
                {
                    name: "localstack-init",
                    configMap: {
                        name: initConfigMapName,
                        defaultMode: 0o755,
                    },
                },
            ];
        }

        const deployment: k8s.V1Deployment = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name: config.name, namespace, labels },
            spec: {
                replicas: 1,
                selector: { matchLabels: { app: config.name } },
                template: {
                    metadata: { labels: { app: config.name, ...labels } },
                    spec: podSpec,
                },
            },
        };

        const service: k8s.V1Service = {
            apiVersion: "v1",
            kind: "Service",
            metadata: { name: config.name, namespace, labels },
            spec: {
                selector: { app: config.name },
                ports: [{ port: PORT, targetPort: PORT }],
            },
        };

        const configMaps: k8s.V1ConfigMap[] = [];
        if (hasInit) {
            configMaps.push({
                apiVersion: "v1",
                kind: "ConfigMap",
                metadata: { name: initConfigMapName, namespace, labels },
                data: { "01-init.sh": buildInitScript(options) },
            });
        }

        return {
            deployments: [deployment],
            statefulSets: [],
            services: [service],
            configMaps,
            persistentVolumeClaims: [],
        };
    }
}

function buildInitScript(options: z.infer<typeof optionsSchema>): string {
    const lines = ["#!/bin/bash", "set -e", ""];

    for (const queue of options.queues) {
        lines.push(`awslocal sqs create-queue --queue-name "${queue}"`);
    }

    for (const bucket of options.buckets) {
        lines.push(`awslocal s3 mb "s3://${bucket}"`);
    }

    lines.push("");
    return lines.join("\n");
}

function buildServicesList(config: ServiceConfig): string[] {
    const services: string[] = [];
    if (config.s3) services.push("s3");
    if (config.sqs) services.push("sqs");
    if (services.length === 0) {
        throw new Error(`AWS recipe "${config.name}" requires at least one service. Set s3: true and/or sqs: true.`);
    }
    return services;
}
