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
 *   2. `hiett/serverless-redis-http` (SRH) - the Upstash-compatible REST
 *      proxy, listening on :8000 (via SRH_PORT) and forwarding to
 *      `localhost:6379`.
 *
 * Source for the proxy: https://github.com/hiett/serverless-redis-http
 * SRH is published multi-arch (amd64 + arm64); the previously-used
 * `darthbenro008/upstash-redis-local` was arm64-only and produced
 * "exec format error" on amd64 preview nodes.
 *
 * Only the REST port (8000) is exposed via the K8s Service; the raw RESP
 * port is intra-Pod only since the @upstash/redis SDK talks REST.
 *
 * Auth: SRH uses a shared bearer token (SRH_TOKEN). Default `local-dev-token`
 * so a standard `@upstash/redis` client config just works; override via
 * `options.token` if you want a different value.
 */
export class UpstashRecipe extends BaseRecipe<UpstashOptions> {
    readonly name = "upstash";
    readonly schema = optionsSchema;

    connectionInfo(config: ServiceConfig): RecipeConnectionInfo {
        return { host: config.name, port: PROXY_PORT };
    }

    typedGenerate(config: ServiceConfig<UpstashOptions>, namespace: string): RecipeResources {
        const proxyVersion = config.version ?? DEFAULT_PROXY_VERSION;
        const proxyImage = `hiett/serverless-redis-http:${proxyVersion}`;
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
                // SRH "env" mode: single backing Redis from SRH_CONNECTION_STRING,
                // bearer token from SRH_TOKEN. SRH_PORT overrides the default 80
                // so the container keeps the recipe's 8000 contract.
                { name: "SRH_MODE", value: "env" },
                { name: "SRH_TOKEN", value: token },
                { name: "SRH_CONNECTION_STRING", value: `redis://127.0.0.1:${REDIS_LOCAL_PORT}` },
                { name: "SRH_PORT", value: String(PROXY_PORT) },
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
            // SRH serves an unauthenticated 200 at GET / ("Welcome to
            // Serverless Redis HTTP!"). Prefer it over a TCP probe: SRH is a
            // BEAM app whose port binds before the app is actually serving,
            // so an HTTP check avoids marking the pod ready too early.
            readinessProbe: {
                httpGet: { path: "/", port: PROXY_PORT },
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
