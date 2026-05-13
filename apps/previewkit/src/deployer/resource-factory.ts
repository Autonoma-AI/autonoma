import type * as k8s from "@kubernetes/client-node";
import type { AppConfig } from "../config/schema";

export interface GatewayRef {
    name: string;
    namespace: string;
    listener: string;
}

interface AppResourceOptions {
    app: AppConfig;
    namespace: string;
    imageTag: string;
    resolvedEnv: Record<string, string>;
    prNumber: number;
    awsSecretName?: string;
}

interface AppRouteOptions {
    app: AppConfig;
    namespace: string;
    prNumber: number;
    repoSlug: string;
    domain: string;
    gateway: GatewayRef;
}

const BASE_LABELS = {
    "previewkit.dev/managed-by": "previewkit",
};

export const HTTP_ROUTE_GROUP = "gateway.networking.k8s.io";
export const HTTP_ROUTE_VERSION = "v1";
export const HTTP_ROUTE_PLURAL = "httproutes";
export const HTTP_ROUTE_API_VERSION = `${HTTP_ROUTE_GROUP}/${HTTP_ROUTE_VERSION}`;

export const TARGET_GROUP_CONFIG_GROUP = "gateway.k8s.aws";
export const TARGET_GROUP_CONFIG_VERSION = "v1beta1";
export const TARGET_GROUP_CONFIG_PLURAL = "targetgroupconfigurations";
export const TARGET_GROUP_CONFIG_API_VERSION = `${TARGET_GROUP_CONFIG_GROUP}/${TARGET_GROUP_CONFIG_VERSION}`;

export function buildAppHostname(appName: string, prNumber: number, repoSlug: string, domain: string): string {
    // Single leftmost label so a wildcard ACM cert (*.domain) matches.
    return `${appName}-pr-${prNumber}-${repoSlug}.${domain}`;
}

export function buildAppDeployment(opts: AppResourceOptions): k8s.V1Deployment {
    const { app, namespace, imageTag, resolvedEnv, awsSecretName } = opts;
    const labels = {
        ...BASE_LABELS,
        app: app.name,
        "previewkit.dev/pr-number": String(opts.prNumber),
    };

    const envVars = Object.entries(resolvedEnv).map(([name, value]) => ({
        name,
        value,
    }));

    const envFrom: k8s.V1EnvFromSource[] = awsSecretName != null ? [{ secretRef: { name: awsSecretName } }] : [];

    return {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: app.name, namespace, labels },
        spec: {
            replicas: app.replicas,
            selector: { matchLabels: { app: app.name } },
            template: {
                metadata: { labels: { ...labels, app: app.name } },
                spec: {
                    nodeSelector: { "kubernetes.io/arch": "amd64" },
                    containers: [
                        {
                            name: app.name,
                            image: imageTag,
                            imagePullPolicy: "Always",
                            ports: [{ containerPort: app.port }],
                            ...(envFrom.length > 0 && { envFrom }),
                            env: envVars,
                            ...(app.command && {
                                command: ["/bin/sh", "-c", app.command],
                            }),
                            resources: {
                                requests: {
                                    cpu: app.resources.cpu,
                                    memory: app.resources.memory,
                                },
                                limits: {
                                    memory: app.resources.memory,
                                },
                            },
                            ...(app.health_check && {
                                readinessProbe: {
                                    httpGet: {
                                        path: app.health_check,
                                        port: app.port,
                                    },
                                    initialDelaySeconds: 10,
                                    periodSeconds: 5,
                                },
                                livenessProbe: {
                                    httpGet: {
                                        path: app.health_check,
                                        port: app.port,
                                    },
                                    initialDelaySeconds: 15,
                                    periodSeconds: 10,
                                },
                            }),
                        },
                    ],
                },
            },
        },
    };
}

export function buildAppService(opts: AppResourceOptions): k8s.V1Service {
    const { app, namespace } = opts;
    const labels = {
        ...BASE_LABELS,
        app: app.name,
        "previewkit.dev/pr-number": String(opts.prNumber),
    };

    return {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: app.name, namespace, labels },
        spec: {
            // ClusterIP is fine: the ALB targets pod IPs directly via
            // TargetGroupConfiguration (targetType: ip), skipping the node hop.
            type: "ClusterIP",
            selector: { app: app.name },
            ports: [{ port: app.port, targetPort: app.port }],
        },
    };
}

export function buildAppHttpRoute(opts: AppRouteOptions): HttpRoute {
    const { app, namespace, prNumber, repoSlug, domain, gateway } = opts;
    const host = buildAppHostname(app.name, prNumber, repoSlug, domain);

    return {
        apiVersion: HTTP_ROUTE_API_VERSION,
        kind: "HTTPRoute",
        metadata: {
            name: app.name,
            namespace,
            labels: routeLabels(app.name, prNumber),
        },
        spec: {
            parentRefs: [
                {
                    group: HTTP_ROUTE_GROUP,
                    kind: "Gateway",
                    name: gateway.name,
                    namespace: gateway.namespace,
                    sectionName: gateway.listener,
                },
            ],
            hostnames: [host],
            rules: [
                {
                    matches: [{ path: { type: "PathPrefix", value: "/" } }],
                    backendRefs: [
                        {
                            group: "",
                            kind: "Service",
                            name: app.name,
                            port: app.port,
                            weight: 1,
                        },
                    ],
                },
            ],
        },
    };
}

export function buildAppTargetGroupConfig(opts: AppRouteOptions): TargetGroupConfiguration {
    const { app, namespace, prNumber } = opts;

    return {
        apiVersion: TARGET_GROUP_CONFIG_API_VERSION,
        kind: "TargetGroupConfiguration",
        metadata: {
            name: app.name,
            namespace,
            labels: routeLabels(app.name, prNumber),
        },
        spec: {
            targetReference: {
                group: "",
                kind: "Service",
                name: app.name,
            },
            defaultConfiguration: {
                targetType: "ip",
                protocol: "HTTP",
                protocolVersion: "HTTP1",
                ...(app.health_check && {
                    healthCheckConfig: {
                        healthCheckPath: app.health_check,
                        healthCheckProtocol: "HTTP",
                    },
                }),
            },
        },
    };
}

function routeLabels(appName: string, prNumber: number): Record<string, string> {
    return {
        ...BASE_LABELS,
        app: appName,
        "previewkit.dev/pr-number": String(prNumber),
    };
}

export interface HttpRoute {
    apiVersion: string;
    kind: "HTTPRoute";
    metadata: {
        name: string;
        namespace: string;
        labels?: Record<string, string>;
    };
    spec: {
        parentRefs: Array<{
            group: string;
            kind: "Gateway";
            name: string;
            namespace: string;
            sectionName?: string;
        }>;
        hostnames: string[];
        rules: Array<{
            matches: Array<{ path: { type: "PathPrefix" | "Exact"; value: string } }>;
            backendRefs: Array<{
                group: string;
                kind: "Service";
                name: string;
                port: number;
                weight: number;
            }>;
        }>;
    };
}

export interface TargetGroupConfiguration {
    apiVersion: string;
    kind: "TargetGroupConfiguration";
    metadata: {
        name: string;
        namespace: string;
        labels?: Record<string, string>;
    };
    spec: {
        targetReference: {
            group: string;
            kind: "Service";
            name: string;
        };
        defaultConfiguration: {
            targetType: "ip" | "instance";
            protocol?: "HTTP" | "HTTPS";
            protocolVersion?: "HTTP1" | "HTTP2" | "GRPC";
            healthCheckConfig?: {
                healthCheckPath?: string;
                healthCheckProtocol?: "HTTP" | "HTTPS";
            };
        };
    };
}
