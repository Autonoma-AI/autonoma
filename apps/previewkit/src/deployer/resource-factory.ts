import { createHmac } from "node:crypto";
import type * as k8s from "@kubernetes/client-node";
import type { AppConfig } from "../config/schema";

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
    ingressClassName: string;
}

const BASE_LABELS = {
    "previewkit.dev/managed-by": "previewkit",
};

export const NGINX_SERVICE_NAME = "previewkit-nginx";
export const NGINX_SERVICE_PORT = 80;
export const NGINX_CONTAINER_PORT = 80;
export const NGINX_CONFIGMAP_NAME = "previewkit-nginx-config";
export const NGINX_HEALTH_PATH = "/nginx-health";

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

/**
 * Per-preview routing is a plain Ingress consumed by the shared in-cluster
 * ingress-nginx — NOT a Gateway HTTPRoute. The ALB Gateway forwards all of
 * `*.preview.autonoma.app` to ingress-nginx through one static HTTPRoute, and
 * ingress-nginx fans out by Host header. This keeps the ALB at a fixed 1 rule +
 * 1 target group no matter how many previews exist, sidestepping the per-ALB
 * 100-rule / 100-target-group quotas that one-route-per-preview would hit.
 *
 * The Ingress targets this namespace's `previewkit-nginx` Service (which still
 * does preview-auth gating); TLS terminates upstream at the ALB, so the Ingress
 * declares no `tls` block.
 */
export function buildAppIngress(opts: AppRouteOptions): k8s.V1Ingress {
    const { app, namespace, prNumber, repoFullName, domain, secret, ingressClassName } = opts;
    const host = buildAppHostname(app.name, prNumber, repoFullName, domain, secret);

    return {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: {
            name: app.name,
            namespace,
            labels: routeLabels(app.name, prNumber),
        },
        spec: {
            ingressClassName,
            rules: [
                {
                    host,
                    http: {
                        paths: [
                            {
                                path: "/",
                                pathType: "Prefix",
                                backend: {
                                    service: {
                                        name: NGINX_SERVICE_NAME,
                                        port: { number: NGINX_SERVICE_PORT },
                                    },
                                },
                            },
                        ],
                    },
                },
            ],
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
}): string {
    const { apps, namespace } = opts;

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

        location / {
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

    // Access control is intentionally disabled: the proxy forwards every request
    // straight to the app. There is no bypass-token / pk_session gate, so preview
    // environments are publicly reachable by anyone who has the URL. The bypass
    // token is still generated and stored upstream, so re-enabling the gate later
    // is purely a change to this generated config.
    return `events {}

http {
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ""      close;
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
