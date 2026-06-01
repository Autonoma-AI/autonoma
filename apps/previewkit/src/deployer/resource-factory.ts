import { createHmac } from "node:crypto";
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
    repoFullName: string;
    domain: string;
    secret: string;
    gateway: GatewayRef;
}

const BASE_LABELS = {
    "previewkit.dev/managed-by": "previewkit",
};

export const NGINX_SERVICE_NAME = "previewkit-nginx";
export const NGINX_SERVICE_PORT = 80;
export const NGINX_CONTAINER_PORT = 80;
export const NGINX_CONFIGMAP_NAME = "previewkit-nginx-config";
export const NGINX_HEALTH_PATH = "/nginx-health";

export const HTTP_ROUTE_GROUP = "gateway.networking.k8s.io";
export const HTTP_ROUTE_VERSION = "v1";
export const HTTP_ROUTE_PLURAL = "httproutes";
export const HTTP_ROUTE_API_VERSION = `${HTTP_ROUTE_GROUP}/${HTTP_ROUTE_VERSION}`;

export const TARGET_GROUP_CONFIG_GROUP = "gateway.k8s.aws";
export const TARGET_GROUP_CONFIG_VERSION = "v1beta1";
export const TARGET_GROUP_CONFIG_PLURAL = "targetgroupconfigurations";
export const TARGET_GROUP_CONFIG_API_VERSION = `${TARGET_GROUP_CONFIG_GROUP}/${TARGET_GROUP_CONFIG_VERSION}`;

export function buildAppHostname(
    appName: string,
    prNumber: number,
    repoFullName: string,
    domain: string,
    secret: string,
): string {
    // HMAC-SHA256 keyed on secret: deterministic per (app, PR, repo) but
    // unguessable without the key.
    const hash = createHmac("sha256", secret)
        .update(`${appName}:${prNumber}:${repoFullName}`)
        .digest("hex")
        .slice(0, 12);
    return `${hash}.${domain}`;
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
    if (!resolvedEnv.PORT) {
        envVars.push({ name: "PORT", value: String(app.port) });
    }

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
    const { app, namespace, prNumber, repoFullName, domain, secret, gateway } = opts;
    const host = buildAppHostname(app.name, prNumber, repoFullName, domain, secret);

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
                            name: NGINX_SERVICE_NAME,
                            port: NGINX_SERVICE_PORT,
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
                name: NGINX_SERVICE_NAME,
            },
            defaultConfiguration: {
                targetType: "ip",
                protocol: "HTTP",
                protocolVersion: "HTTP1",
                healthCheckConfig: {
                    healthCheckPath: NGINX_HEALTH_PATH,
                    healthCheckProtocol: "HTTP",
                },
            },
        },
    };
}

interface NginxOptions {
    apps: Array<{ name: string; port: number; hostname: string }>;
    namespace: string;
    prNumber: number;
    bypassToken: string;
    domain: string;
    appUrl: string;
    nginxImage: string;
}

export function buildNginxConfig(opts: {
    apps: Array<{ name: string; port: number; hostname: string }>;
    namespace: string;
    bypassToken: string;
    domain: string;
    appUrl: string;
}): string {
    const { apps, namespace, bypassToken, domain, appUrl } = opts;

    // Inline auth page: reads ?session + ?next, sets cookie on the parent domain,
    // redirects. Embedded in nginx return 200 '...', so JS must use only double
    // quotes — no single quotes allowed inside the nginx single-quoted string.
    const authScript = `(function(){var p=new URLSearchParams(location.search);var s=p.get("session");var n=p.get("next")||"/";if(s){document.cookie="pk_session="+encodeURIComponent(s)+"; path=/; domain=.${domain}; max-age=86400; secure; samesite=lax"}location.replace(n)})()`;
    const authHtml = `<html><body><script>${authScript}</script></body></html>`;

    const serverBlocks = apps
        .map(
            ({ name, port, hostname }) => `
    server {
        listen 80;
        server_name ${hostname};

        location = ${NGINX_HEALTH_PATH} {
            return 200 "ok";
            add_header Content-Type text/plain;
        }

        location = /preview-auth {
            add_header Cache-Control "no-store";
            return 200 '${authHtml}';
            default_type text/html;
        }

        location / {
            if ($is_auth = "0") {
                return 302 ${appUrl}/preview-auth?redirect=https://$host$request_uri;
            }
            proxy_pass http://${name}.${namespace}.svc.cluster.local:${port};
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-Host $host;
            proxy_set_header X-Forwarded-Proto https;
            proxy_read_timeout 60s;
            proxy_send_timeout 60s;
        }
    }`,
        )
        .join("\n");

    return `events {}

http {
    # bypass token is a 64-char hex string; default bucket size of 64 is too small
    map_hash_bucket_size 128;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ""      close;
    }

    map $http_x_previewkit_bypass $bypass_ok {
        "${bypassToken}" "1";
        default "0";
    }

    map $cookie_pk_session $session_ok {
        "${bypassToken}" "1";
        default "0";
    }

    map "$bypass_ok:$session_ok" $is_auth {
        "~1" "1";
        default "0";
    }
${serverBlocks}
}
`;
}

export function buildNginxConfigMap(opts: NginxOptions): k8s.V1ConfigMap {
    const labels = {
        ...BASE_LABELS,
        app: NGINX_SERVICE_NAME,
        "previewkit.dev/pr-number": String(opts.prNumber),
    };
    const nginxConf = buildNginxConfig({
        apps: opts.apps,
        namespace: opts.namespace,
        bypassToken: opts.bypassToken,
        domain: opts.domain,
        appUrl: opts.appUrl,
    });
    return {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: NGINX_CONFIGMAP_NAME, namespace: opts.namespace, labels },
        data: { "nginx.conf": nginxConf },
    };
}

export function buildNginxDeployment(namespace: string, prNumber: number, nginxImage: string): k8s.V1Deployment {
    const labels = {
        ...BASE_LABELS,
        app: NGINX_SERVICE_NAME,
        "previewkit.dev/pr-number": String(prNumber),
    };
    return {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: NGINX_SERVICE_NAME, namespace, labels },
        spec: {
            replicas: 1,
            selector: { matchLabels: { app: NGINX_SERVICE_NAME } },
            template: {
                metadata: { labels },
                spec: {
                    nodeSelector: { "kubernetes.io/arch": "amd64" },
                    containers: [
                        {
                            name: NGINX_SERVICE_NAME,
                            image: nginxImage,
                            imagePullPolicy: "Always",
                            ports: [{ containerPort: NGINX_CONTAINER_PORT }],
                            resources: {
                                requests: { cpu: "50m", memory: "32Mi" },
                                limits: { memory: "64Mi" },
                            },
                            readinessProbe: {
                                httpGet: { path: NGINX_HEALTH_PATH, port: NGINX_CONTAINER_PORT },
                                initialDelaySeconds: 3,
                                periodSeconds: 5,
                            },
                            volumeMounts: [
                                {
                                    name: "nginx-config",
                                    mountPath: "/etc/nginx/nginx.conf",
                                    subPath: "nginx.conf",
                                    readOnly: true,
                                },
                            ],
                        },
                    ],
                    volumes: [
                        {
                            name: "nginx-config",
                            configMap: { name: NGINX_CONFIGMAP_NAME },
                        },
                    ],
                },
            },
        },
    };
}

export function buildNginxService(namespace: string, prNumber: number): k8s.V1Service {
    const labels = {
        ...BASE_LABELS,
        app: NGINX_SERVICE_NAME,
        "previewkit.dev/pr-number": String(prNumber),
    };
    return {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: NGINX_SERVICE_NAME, namespace, labels },
        spec: {
            type: "ClusterIP",
            selector: { app: NGINX_SERVICE_NAME },
            ports: [{ port: NGINX_SERVICE_PORT, targetPort: NGINX_CONTAINER_PORT }],
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
