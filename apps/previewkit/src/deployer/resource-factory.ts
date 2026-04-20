import type * as k8s from "@kubernetes/client-node";
import type { AppConfig } from "../config/schema";

interface AppResourceOptions {
    app: AppConfig;
    namespace: string;
    imageTag: string;
    resolvedEnv: Record<string, string>;
    prNumber: number;
}

interface NginxResourceOptions {
    apps: AppConfig[];
    namespace: string;
    owner: string;
    prNumber: number;
    domain: string;
}

interface NginxResources {
    configMap: k8s.V1ConfigMap;
    deployment: k8s.V1Deployment;
    service: k8s.V1Service;
    ingress: k8s.V1Ingress;
}

const BASE_LABELS = {
    "previewkit.dev/managed-by": "previewkit",
};

export function buildAppDeployment(opts: AppResourceOptions): k8s.V1Deployment {
    const { app, namespace, imageTag, resolvedEnv } = opts;
    const labels = {
        ...BASE_LABELS,
        app: app.name,
        "previewkit.dev/pr-number": String(opts.prNumber),
    };

    const envVars = Object.entries(resolvedEnv).map(([name, value]) => ({
        name,
        value,
    }));

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
                    containers: [
                        {
                            name: app.name,
                            image: imageTag,
                            ports: [{ containerPort: app.port }],
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
            selector: { app: app.name },
            ports: [{ port: app.port, targetPort: app.port }],
        },
    };
}

function buildNginxConfig(apps: AppConfig[], owner: string, prNumber: number, domain: string): string {
    const serverBlocks = apps.map((app) => {
        const host = `${app.name}.pr-${prNumber}.${owner}.${domain}`;
        return `    server {
        listen 80;
        server_name ${host};

        location / {
            proxy_pass http://${app.name}:${app.port};
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }`;
    });

    return `events {
    worker_connections 1024;
}

http {
    resolver kube-dns.kube-system.svc.cluster.local valid=5s;

${serverBlocks.join("\n\n")}

    server {
        listen 80 default_server;
        return 404;
    }
}
`;
}

export function buildNginxResources(opts: NginxResourceOptions): NginxResources {
    const { apps, namespace, owner, prNumber, domain } = opts;
    const labels = {
        ...BASE_LABELS,
        app: "nginx-router",
        "previewkit.dev/pr-number": String(prNumber),
    };
    const wildcardHost = `*.pr-${prNumber}.${owner}.${domain}`;

    const configMap: k8s.V1ConfigMap = {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
            name: "nginx-router-config",
            namespace,
            labels,
        },
        data: {
            "nginx.conf": buildNginxConfig(apps, owner, prNumber, domain),
        },
    };

    const deployment: k8s.V1Deployment = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
            name: "nginx-router",
            namespace,
            labels,
        },
        spec: {
            replicas: 1,
            selector: { matchLabels: { app: "nginx-router" } },
            template: {
                metadata: { labels: { ...labels, app: "nginx-router" } },
                spec: {
                    containers: [
                        {
                            name: "nginx",
                            image: "nginx:1-alpine",
                            ports: [{ containerPort: 80 }],
                            volumeMounts: [
                                {
                                    name: "config",
                                    mountPath: "/etc/nginx/nginx.conf",
                                    subPath: "nginx.conf",
                                    readOnly: true,
                                },
                            ],
                            resources: {
                                requests: { cpu: "50m", memory: "32Mi" },
                                limits: { memory: "64Mi" },
                            },
                            readinessProbe: {
                                tcpSocket: { port: 80 },
                                initialDelaySeconds: 2,
                                periodSeconds: 5,
                            },
                        },
                    ],
                    volumes: [
                        {
                            name: "config",
                            configMap: { name: "nginx-router-config" },
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
            name: "nginx-router",
            namespace,
            labels,
        },
        spec: {
            selector: { app: "nginx-router" },
            ports: [{ port: 80, targetPort: 80 }],
        },
    };

    const ingress: k8s.V1Ingress = {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: {
            name: "nginx-router-ingress",
            namespace,
            labels,
        },
        spec: {
            rules: [
                {
                    host: wildcardHost,
                    http: {
                        paths: [
                            {
                                path: "/",
                                pathType: "Prefix",
                                backend: {
                                    service: {
                                        name: "nginx-router",
                                        port: { number: 80 },
                                    },
                                },
                            },
                        ],
                    },
                },
            ],
        },
    };

    return { configMap, deployment, service, ingress };
}
