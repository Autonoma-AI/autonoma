import type * as k8s from "@kubernetes/client-node";
import { z } from "zod";
import type { ServiceConfig } from "../config/schema";
import { BaseRecipe, type RecipeConnectionInfo, type RecipeResources } from "./recipe";

const DEFAULT_PROXY_VERSION = "latest";
const DEFAULT_REDIS_VERSION = "7-alpine";
const DEFAULT_TOKEN = "local-dev-token";
const PROXY_PORT = 8000;
const REDIS_LOCAL_PORT = 6379;

const optionsSchema = z.object({
    /**
     * Shared bearer token between the proxy and consuming apps. Default
     * matches the upstream docker-compose so the existing example just
     * works; override only when the default conflicts or you want a
     * different value baked into the preview env. Apps set this same value
     * in `UPSTASH_REDIS_REST_TOKEN`.
     */
    token: z.string().min(1).default(DEFAULT_TOKEN),
    /**
     * Tag for the backing Redis container. The top-level `version` field
     * controls the proxy image tag instead; Redis is a different image.
     */
    redis_version: z.string().min(1).default(DEFAULT_REDIS_VERSION),
});

export type UpstashOptions = z.infer<typeof optionsSchema>;

/**
 * Upstash-Redis emulator for preview environments. Apps that talk to
 * Upstash's REST API in production (via `@upstash/redis`) can target this
 * service unchanged - only `UPSTASH_REDIS_REST_URL` points at this preview
 * instead of the real `*.upstash.io`.
 *
 * The recipe deploys two containers in a single Pod:
 *   1. `redis:7-alpine` - the actual data store, bound to 127.0.0.1:6379
 *      so it is reachable only by the sidecar in the same Pod.
 *   2. `darthbenro008/upstash-redis-local` - the REST proxy listening on
 *      :8000 and forwarding to `localhost:6379`.
 *
 * Source for the proxy: https://github.com/aine1100/Upstash-Redis-Local-server
 *
 * Only the REST port (8000) is exposed via the K8s Service; the raw RESP
 * port is intra-Pod only since the @upstash/redis SDK talks REST.
 *
 * Auth: the proxy uses a shared bearer token. Default `local-dev-token`
 * matches the upstream docker-compose so the standard example just works;
 * override via `options.token` if you want a different value.
 */
export class UpstashRecipe extends BaseRecipe<UpstashOptions> {
    readonly name = "upstash";
    readonly schema = optionsSchema;

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        return { host: config.name, port: PROXY_PORT };
    }

    typedGenerate(config: ServiceConfig<UpstashOptions>, namespace: string): RecipeResources {
        const proxyVersion = config.version ?? DEFAULT_PROXY_VERSION;
        const proxyImage = `darthbenro008/upstash-redis-local:${proxyVersion}`;
        const redisImage = `redis:${config.options.redis_version}`;
        const token = config.options.token;
        const labels = {
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": config.name,
        };

        const redisContainer: k8s.V1Container = {
            name: "redis",
            image: redisImage,
            args: ["--bind", "127.0.0.1", "--port", String(REDIS_LOCAL_PORT)],
            ports: [{ name: "redis", containerPort: REDIS_LOCAL_PORT }],
            resources: {
                requests: { cpu: "50m", memory: "64Mi" },
                limits: { memory: "128Mi" },
            },
            readinessProbe: {
                exec: { command: ["redis-cli", "-p", String(REDIS_LOCAL_PORT), "ping"] },
                initialDelaySeconds: 2,
                periodSeconds: 5,
            },
        };

        const proxyContainer: k8s.V1Container = {
            name: "proxy",
            image: proxyImage,
            env: [
                { name: "UPSTASH_TOKEN", value: token },
                { name: "REDIS_ADDR", value: `127.0.0.1:${REDIS_LOCAL_PORT}` },
                ...Object.entries(config.env).map(([name, value]) => ({ name, value })),
            ],
            ports: [{ name: "http", containerPort: PROXY_PORT }],
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
                    path: "/PING",
                    port: PROXY_PORT,
                    httpHeaders: [{ name: "Authorization", value: `Bearer ${token}` }],
                },
                initialDelaySeconds: 3,
                periodSeconds: 5,
            },
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
                        containers: [redisContainer, proxyContainer],
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
                ports: [{ name: "http", port: PROXY_PORT, targetPort: PROXY_PORT }],
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
