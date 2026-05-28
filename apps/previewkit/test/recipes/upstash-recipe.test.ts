import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../../src/config/schema";
import { UpstashRecipe } from "../../src/recipes/upstash-recipe";

const baseService = (overrides: Partial<ServiceConfig> = {}): ServiceConfig => ({
    name: "cache",
    recipe: "upstash",
    env: {},
    options: {},
    resources: { cpu: "250m", memory: "256Mi" },
    ...overrides,
});

describe("UpstashRecipe", () => {
    const recipe = new UpstashRecipe();

    it("registers under the name 'upstash'", () => {
        expect(recipe.name).toBe("upstash");
    });

    it("returns the service name and 8000 (REST port) as connection info", () => {
        expect(recipe.connectionInfo(baseService())).toEqual({ host: "cache", port: 8000 });
    });

    it("generates one Deployment and one Service (no statefulsets, configmaps, or PVCs)", () => {
        const result = recipe.generate(baseService(), "ns");
        expect(result.deployments).toHaveLength(1);
        expect(result.services).toHaveLength(1);
        expect(result.statefulSets).toEqual([]);
        expect(result.configMaps).toEqual([]);
        expect(result.persistentVolumeClaims).toEqual([]);
    });

    it("deploys both Redis and the proxy in the same Pod", () => {
        const result = recipe.generate(baseService(), "ns");
        const containers = result.deployments[0]?.spec?.template?.spec?.containers ?? [];
        const names = containers.map((c) => c.name);
        expect(names).toEqual(["redis", "proxy"]);
    });

    it("defaults to the latest proxy image and redis:7-alpine backend", () => {
        const result = recipe.generate(baseService(), "ns");
        const containers = result.deployments[0]?.spec?.template?.spec?.containers ?? [];
        const redis = containers.find((c) => c.name === "redis");
        const proxy = containers.find((c) => c.name === "proxy");
        expect(redis?.image).toBe("redis:7-alpine");
        expect(proxy?.image).toBe("darthbenro008/upstash-redis-local:latest");
    });

    it("honors an explicit version on the proxy image", () => {
        const result = recipe.generate(baseService({ version: "v0.2.0" }), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.image).toBe("darthbenro008/upstash-redis-local:v0.2.0");
    });

    it("honors options.redis_version on the backing Redis image", () => {
        const result = recipe.generate(baseService({ options: { redis_version: "8-alpine" } }), "ns");
        const redis = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "redis");
        expect(redis?.image).toBe("redis:8-alpine");
    });

    it("binds Redis to 127.0.0.1 so other pods cannot reach the raw RESP port", () => {
        const result = recipe.generate(baseService(), "ns");
        const redis = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "redis");
        expect(redis?.args).toEqual(["--bind", "127.0.0.1", "--port", "6379"]);
    });

    it("points the proxy at localhost:6379 via REDIS_ADDR", () => {
        const result = recipe.generate(baseService(), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.env).toContainEqual({ name: "REDIS_ADDR", value: "127.0.0.1:6379" });
    });

    it("defaults UPSTASH_TOKEN to 'local-dev-token' (matches upstream docker-compose)", () => {
        const result = recipe.generate(baseService(), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.env).toContainEqual({ name: "UPSTASH_TOKEN", value: "local-dev-token" });
    });

    it("uses options.token when set", () => {
        const result = recipe.generate(baseService({ options: { token: "super-secret-abc" } }), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.env).toContainEqual({ name: "UPSTASH_TOKEN", value: "super-secret-abc" });
    });

    it("exposes only the REST port on the Service (not the raw Redis port)", () => {
        const result = recipe.generate(baseService(), "ns");
        const service = result.services[0];
        expect(service?.spec?.ports).toEqual([{ name: "http", port: 8000, targetPort: 8000 }]);
    });

    it("includes the bearer token in the readiness probe so /PING succeeds when auth is required", () => {
        const result = recipe.generate(baseService({ options: { token: "tok-xyz" } }), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.readinessProbe?.httpGet?.path).toBe("/PING");
        expect(proxy?.readinessProbe?.httpGet?.port).toBe(8000);
        expect(proxy?.readinessProbe?.httpGet?.httpHeaders).toEqual([
            { name: "Authorization", value: "Bearer tok-xyz" },
        ]);
    });

    it("forwards env vars from the service config into the proxy container only", () => {
        const result = recipe.generate(baseService({ env: { LOG_LEVEL: "debug" } }), "ns");
        const containers = result.deployments[0]?.spec?.template?.spec?.containers ?? [];
        const redis = containers.find((c) => c.name === "redis");
        const proxy = containers.find((c) => c.name === "proxy");
        expect(proxy?.env).toContainEqual({ name: "LOG_LEVEL", value: "debug" });
        expect(redis?.env ?? []).toEqual([]);
    });

    it("scopes resources to the requested namespace", () => {
        const result = recipe.generate(baseService(), "preview-ns");
        expect(result.deployments[0]?.metadata?.namespace).toBe("preview-ns");
        expect(result.services[0]?.metadata?.namespace).toBe("preview-ns");
    });

    it("applies the previewkit ownership labels", () => {
        const result = recipe.generate(baseService(), "ns");
        expect(result.deployments[0]?.metadata?.labels).toMatchObject({
            "previewkit.dev/managed-by": "previewkit",
            "previewkit.dev/service": "cache",
        });
    });

    it("requests cpu+memory on the proxy and limits memory only", () => {
        const result = recipe.generate(baseService({ resources: { cpu: "500m", memory: "512Mi" } }), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.resources?.requests).toEqual({ cpu: "500m", memory: "512Mi" });
        expect(proxy?.resources?.limits).toEqual({ memory: "512Mi" });
    });

    it("gives Redis a small fixed budget independent of config.resources", () => {
        const result = recipe.generate(baseService({ resources: { cpu: "2000m", memory: "2Gi" } }), "ns");
        const redis = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "redis");
        expect(redis?.resources?.requests).toEqual({ cpu: "50m", memory: "64Mi" });
        expect(redis?.resources?.limits).toEqual({ memory: "128Mi" });
    });
});
