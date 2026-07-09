import type * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { ServiceConfig } from "../config/schema";
import { BaseRecipe, type RecipeConnectionInfo, type RecipeResources } from "./recipe";

const DEFAULT_VERSION = "latest";
const PORT = 4566;

const subscriptionSchema = z.object({
    topic: z.string(),
    queue: z.string(),
    filter_policy: z.string().optional(),
});

const s3NotificationSchema = z.object({
    bucket: z.string(),
    queue: z.string(),
    events: z.array(z.string()).default(["s3:ObjectCreated:*"]),
});

const optionsSchema = z.object({
    queues: z.array(z.string()).default([]),
    buckets: z.array(z.string()).default([]),
    topics: z.array(z.string()).default([]),
    subscriptions: z.array(subscriptionSchema).default([]),
    s3_notifications: z.array(s3NotificationSchema).default([]),
});

export type AwsOptions = z.infer<typeof optionsSchema>;

export class AwsRecipe extends BaseRecipe<AwsOptions> {
    readonly name = "aws";
    readonly schema = optionsSchema;

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        return { host: config.name, port: PORT };
    }

    typedGenerate(config: ServiceConfig<AwsOptions>, namespace: string): RecipeResources {
        const options = config.options;
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
                    memory: config.resources.memoryRequest,
                },
                limits: {
                    memory: config.resources.memoryLimit,
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

function buildInitScript(options: AwsOptions): string {
    const lines = ["#!/bin/bash", "set -e", ""];

    for (const queue of options.queues) {
        lines.push(`awslocal sqs create-queue --queue-name "${queue}"`);
    }

    for (const bucket of options.buckets) {
        lines.push(`awslocal s3 mb "s3://${bucket}"`);
    }

    for (const topic of options.topics) {
        lines.push(`awslocal sns create-topic --name "${topic}"`);
    }

    for (const sub of options.subscriptions) {
        const topicArn = `arn:aws:sns:us-east-1:000000000000:${sub.topic}`;
        const queueArn = `arn:aws:sqs:us-east-1:000000000000:${sub.queue}`;
        if (sub.filter_policy != null) {
            const escaped = sub.filter_policy.replace(/'/g, "'\\''");
            lines.push(
                `awslocal sns subscribe --topic-arn "${topicArn}" --protocol sqs --notification-endpoint "${queueArn}" --attributes '{"FilterPolicy":"${escaped}"}'`,
            );
        } else {
            lines.push(
                `awslocal sns subscribe --topic-arn "${topicArn}" --protocol sqs --notification-endpoint "${queueArn}"`,
            );
        }
    }

    for (const notif of options.s3_notifications) {
        const queueArn = `arn:aws:sqs:us-east-1:000000000000:${notif.queue}`;
        const eventsJson = notif.events.map((e) => `\\"${e}\\"`).join(",");
        const config = `{"QueueConfigurations":[{"QueueArn":"${queueArn}","Events":[${eventsJson}]}]}`;
        lines.push(
            `awslocal s3api put-bucket-notification-configuration --bucket "${notif.bucket}" --notification-configuration '${config}'`,
        );
    }

    lines.push("");
    return lines.join("\n");
}

function buildServicesList(config: ServiceConfig): string[] {
    const services: string[] = [];
    if (config.s3) services.push("s3");
    if (config.sqs) services.push("sqs");
    if (config.sns) services.push("sns");
    if (services.length === 0) {
        throw new Error(
            `AWS recipe "${config.name}" requires at least one service. Set s3: true, sqs: true, and/or sns: true.`,
        );
    }
    return services;
}
