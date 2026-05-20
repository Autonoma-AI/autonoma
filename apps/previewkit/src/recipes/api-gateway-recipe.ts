import type * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { ServiceConfig } from "../config/schema";
import type { Recipe, RecipeConnectionInfo, RecipeResources } from "./recipe";

const DEFAULT_VERSION = "1.27-alpine";
const PORT = 80;

// Placeholder replaced at container startup with the actual cluster DNS IP
// read from /etc/resolv.conf. Using a placeholder avoids baking a hard-coded
// IP into the ConfigMap while still allowing the `set $var; proxy_pass $var`
// pattern that defers DNS resolution to request time.
const RESOLVER_PLACEHOLDER = "__CLUSTER_RESOLVER__";

const routeSchema = z.object({
    path: z.string().min(1),
    target: z.string().min(1),
    strip_prefix: z.boolean().default(false),
    rewrite: z.string().optional(),
});

const optionsSchema = z.object({
    routes: z.array(routeSchema).min(1, "api-gateway requires at least one route"),
    client_max_body_size: z.string().default("10m"),
});

type ApiGatewayOptions = z.infer<typeof optionsSchema>;

export class ApiGatewayRecipe implements Recipe {
    readonly name = "api-gateway";

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        return { host: config.name, port: PORT };
    }

    generate(config: ServiceConfig, namespace: string): RecipeResources {
        const options = optionsSchema.parse(config.options);
        const version = config.version ?? DEFAULT_VERSION;
        const image = `nginx:${version}`;
        const labels = {
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": config.name,
        };

        const configMap: k8s.V1ConfigMap = {
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: { name: `${config.name}-nginx`, namespace, labels },
            data: { "default.conf": buildNginxConfig(options) },
        };

        // Override the default entrypoint to inject the cluster DNS resolver IP
        // before starting nginx. nginx resolves upstream hostnames at startup when
        // using static proxy_pass, which fails because app K8s Services don't exist
        // yet at service-recipe deploy time. The `set $var; proxy_pass $var` pattern
        // defers resolution to request time, but requires a `resolver` directive
        // with a valid IP. We read it from /etc/resolv.conf at startup.
        // The ConfigMap is mounted read-only, so sed -i fails. Instead, read from
        // the source mount, substitute in-memory, and write to the writable
        // /etc/nginx/conf.d/ directory that nginx reads from.
        const startCommand = [
            "/bin/sh",
            "-c",
            `RESOLVER=$(grep nameserver /etc/resolv.conf | awk 'NR==1 {print $2}') && ` +
                `sed "s/${RESOLVER_PLACEHOLDER}/$RESOLVER/g" /etc/nginx-source/default.conf > /etc/nginx/conf.d/default.conf && ` +
                `exec nginx -g 'daemon off;'`,
        ];

        const deployment: k8s.V1Deployment = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name: config.name, namespace, labels },
            spec: {
                replicas: 1,
                selector: { matchLabels: { app: config.name } },
                template: {
                    metadata: {
                        labels: { app: config.name, ...labels },
                        annotations: { "previewkit.dev/config-hash": hashConfig(options) },
                    },
                    spec: {
                        containers: [
                            {
                                name: config.name,
                                image,
                                command: startCommand,
                                ports: [{ containerPort: PORT }],
                                env: Object.entries(config.env).map(([name, value]) => ({ name, value })),
                                resources: {
                                    requests: {
                                        cpu: config.resources.cpu,
                                        memory: config.resources.memory,
                                    },
                                    limits: { memory: config.resources.memory },
                                },
                                volumeMounts: [
                                    {
                                        name: "nginx-config",
                                        mountPath: "/etc/nginx-source",
                                    },
                                ],
                                readinessProbe: {
                                    httpGet: { path: "/_health", port: PORT },
                                    initialDelaySeconds: 2,
                                    periodSeconds: 5,
                                },
                            },
                        ],
                        volumes: [
                            {
                                name: "nginx-config",
                                configMap: { name: `${config.name}-nginx` },
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
                ports: [{ port: PORT, targetPort: PORT }],
            },
        };

        return {
            deployments: [deployment],
            statefulSets: [],
            services: [service],
            configMaps: [configMap],
            persistentVolumeClaims: [],
        };
    }
}

function buildNginxConfig(options: ApiGatewayOptions): string {
    const locationBlocks = sortByPathSpecificity(options.routes).map((route, index) => {
        const target = normalizeTarget(route.target);
        const rewrite = buildRewrite(route);
        // Use a numbered variable per route so nginx defers DNS resolution to
        // request time rather than startup. Variable names cannot contain hyphens,
        // so we use a positional index instead of the target hostname.
        const varName = `$upstream_${index}`;
        return [
            `    location ${route.path} {`,
            rewrite,
            `        set ${varName} ${target};`,
            `        proxy_pass ${varName};`,
            `        proxy_http_version 1.1;`,
            `        proxy_set_header Host $host;`,
            `        proxy_set_header X-Real-IP $remote_addr;`,
            `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
            `        proxy_set_header X-Forwarded-Proto $scheme;`,
            `        proxy_set_header X-Forwarded-Host $host;`,
            `        proxy_read_timeout 60s;`,
            `        proxy_connect_timeout 10s;`,
            `    }`,
        ]
            .filter((line) => line.length > 0)
            .join("\n");
    });

    return [
        // Resolver IP is injected at container startup from /etc/resolv.conf.
        // valid=5s keeps the TTL short so upstream IP changes propagate quickly.
        `resolver ${RESOLVER_PLACEHOLDER} valid=5s ipv6=off;`,
        "",
        "server {",
        `    listen ${PORT};`,
        `    client_max_body_size ${options.client_max_body_size};`,
        "",
        "    location = /_health {",
        "        access_log off;",
        `        return 200 "ok\\n";`,
        "    }",
        "",
        ...locationBlocks,
        "}",
        "",
    ].join("\n");
}

function buildRewrite(route: z.infer<typeof routeSchema>): string {
    if (route.rewrite != null) {
        return `        rewrite ^${route.path}(.*)$ ${route.rewrite}$1 break;`;
    }
    if (route.strip_prefix) {
        const prefix = route.path.replace(/\/$/, "");
        return `        rewrite ^${prefix}(/.*)$ $1 break;`;
    }
    return "";
}

function normalizeTarget(target: string): string {
    if (target.startsWith("http://") || target.startsWith("https://")) return target;
    return `http://${target}`;
}

function sortByPathSpecificity(routes: ApiGatewayOptions["routes"]): ApiGatewayOptions["routes"] {
    return [...routes].sort((a, b) => b.path.length - a.path.length);
}

function hashConfig(options: ApiGatewayOptions): string {
    let hash = 0;
    const str = JSON.stringify(options);
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return hash.toString(16);
}
