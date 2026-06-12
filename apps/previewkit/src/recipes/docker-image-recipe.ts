import type * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { ServiceConfig } from "../config/schema";
import { BaseRecipe, type RecipeConnectionInfo, type RecipeResources } from "./recipe";

const portSchema = z.object({
    name: z.string().optional(),
    port: z.number().int().positive().max(65_535),
});

// One of `http`, `exec`, or `tcp` must be set. Mirrors the K8s probe
// shapes so users can express the probe they need declaratively.
const probeSchema = z
    .object({
        http: z.object({ path: z.string().min(1), port_definition: portSchema }).optional(),
        exec: z
            .object({
                command: z.array(z.string().min(1)).nonempty(),
            })
            .optional(),
        tcp: z.object({ port_definition: portSchema }).optional(),
        initial_delay_seconds: z.number().int().nonnegative().optional(),
        period_seconds: z.number().int().positive().optional(),
    })
    .refine(
        (p) => [p.http, p.exec, p.tcp].filter((x) => x != null).length === 1,
        "readiness must specify exactly one of: http, exec, tcp",
    );

export const dockerImageOptionsSchema = z.object({
    image: z.string().min(1),
    port_definition: portSchema,
    additional_ports: z.array(portSchema).default([]),
    command: z.array(z.string()).optional(),
    args: z.array(z.string()).optional(),
    readiness: probeSchema.optional(),
});

export type DockerImageOptions = z.infer<typeof dockerImageOptionsSchema>;

export class DockerImageRecipe extends BaseRecipe<DockerImageOptions> {
    readonly name: string = "docker-image";
    readonly schema = dockerImageOptionsSchema;

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        const options = this.parseOptions(config);
        return { host: config.name, port: options.port_definition.port };
    }

    typedGenerate(config: ServiceConfig<DockerImageOptions>, namespace: string): RecipeResources {
        const options = config.options;
        const labels = {
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": config.name,
        };

        const containerPorts: k8s.V1ContainerPort[] = [];
        const port = options.port_definition.port;

        const primary: k8s.V1ContainerPort = {
            containerPort: port,
            name: options.port_definition.name ?? "primary",
        };
        containerPorts.push(primary);
        for (const ap of options.additional_ports) {
            containerPorts.push({ name: ap.name, containerPort: ap.port });
        }

        const container: k8s.V1Container = {
            name: config.name,
            image: options.image,
            env: Object.entries(config.env).map(([name, value]) => ({ name, value })),
            resources: {
                requests: {
                    cpu: config.resources.cpu,
                    memory: config.resources.memoryRequest,
                },
                limits: { memory: config.resources.memoryLimit },
            },
        };

        if (options.command != null) container.command = options.command;
        if (options.args != null) container.args = options.args;
        if (containerPorts.length > 0) container.ports = containerPorts;
        const probe = this.buildReadinessProbe(options);
        if (probe != null) container.readinessProbe = probe;

        const deployment: k8s.V1Deployment = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name: config.name, namespace, labels },
            spec: {
                replicas: 1,
                selector: { matchLabels: { app: config.name } },
                template: {
                    metadata: { labels: { app: config.name, ...labels } },
                    spec: { containers: [container] },
                },
            },
        };

        const services: k8s.V1Service[] = [];
        const primaryPort: k8s.V1ServicePort = {
            port: port,
            targetPort: port,
            name: options.port_definition.name ?? "primary",
        };
        const servicePorts: k8s.V1ServicePort[] = [primaryPort];
        for (const ap of options.additional_ports) {
            servicePorts.push({ name: ap.name, port: ap.port, targetPort: ap.port });
        }
        services.push({
            apiVersion: "v1",
            kind: "Service",
            metadata: { name: config.name, namespace, labels },
            spec: {
                selector: { app: config.name },
                ports: servicePorts,
            },
        });

        return {
            deployments: [deployment],
            statefulSets: [],
            services,
            configMaps: [],
            persistentVolumeClaims: [],
        };
    }

    private buildReadinessProbe(options: DockerImageOptions): k8s.V1Probe | undefined {
        const readiness = options.readiness;
        if (readiness == null) return undefined;

        const probe: k8s.V1Probe = {};
        if (readiness.http != null) {
            const port = readiness.http.port_definition.port ?? options.port_definition.port;
            probe.httpGet = { path: readiness.http.path, port: port };
        } else if (readiness.exec != null) {
            probe.exec = { command: [...readiness.exec.command] };
        } else if (readiness.tcp != null) {
            const port = readiness.tcp.port_definition.port ?? options.port_definition.port;
            probe.tcpSocket = { port };
        }
        if (readiness.initial_delay_seconds != null) probe.initialDelaySeconds = readiness.initial_delay_seconds;
        if (readiness.period_seconds != null) probe.periodSeconds = readiness.period_seconds;
        return probe;
    }
}
