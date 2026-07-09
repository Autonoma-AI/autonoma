import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../../src/config/schema";
import { UpstashRecipe } from "../../src/recipes/upstash-recipe";

const baseService = (overrides: Partial<ServiceConfig> = {}): ServiceConfig => ({
    name: "cache",
    recipe: "upstash",
    env: {},
    options: {},
    resources: { cpu: "250m", memoryRequest: "256Mi", memoryLimit: "512Mi" },
    ...overrides,
});

describe("UpstashRecipe", () => {
    const recipe = new UpstashRecipe();

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

    it("defaults to the latest SRH proxy image and redis:7-alpine backend", () => {
        const result = recipe.generate(baseService(), "ns");
        const containers = result.deployments[0]?.spec?.template?.spec?.containers ?? [];
        const redis = containers.find((c) => c.name === "redis");
        const proxy = containers.find((c) => c.name === "proxy");
        expect(redis?.image).toBe("redis:7-alpine");
        // SRH is multi-arch; the old darthbenro008 image was arm64-only.
        expect(proxy?.image).toBe("hiett/serverless-redis-http:latest");
    });

    it("honors an explicit version on the proxy image", () => {
        const result = recipe.generate(baseService({ version: "v1.0.7" }), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.image).toBe("hiett/serverless-redis-http:v1.0.7");
    });

    it("honors options.redis_version on the backing Redis image", () => {
        const result = recipe.generate(baseService({ options: { redis_version: "8-alpine" } }), "ns");
        const redis = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "redis");
        expect(redis?.image).toBe("redis:8-alpine");
    });

    it("binds Redis to 0.0.0.0 so the Service can route the RESP port to other pods", () => {
        const result = recipe.generate(baseService(), "ns");
        const redis = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "redis");
        expect(redis?.args).toEqual(["--bind", "0.0.0.0", "--port", "6379"]);
    });

    it("runs SRH in env mode pointed at localhost:6379", () => {
        const result = recipe.generate(baseService(), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.env).toContainEqual({ name: "SRH_MODE", value: "env" });
        expect(proxy?.env).toContainEqual({ name: "SRH_CONNECTION_STRING", value: "redis://127.0.0.1:6379" });
    });

    it("overrides SRH_PORT to keep the 8000 contract", () => {
        const result = recipe.generate(baseService(), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.env).toContainEqual({ name: "SRH_PORT", value: "8000" });
    });

    it("defaults SRH_TOKEN to 'local-dev-token'", () => {
        const result = recipe.generate(baseService(), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.env).toContainEqual({ name: "SRH_TOKEN", value: "local-dev-token" });
    });

    it("uses options.token as SRH_TOKEN when set", () => {
        const result = recipe.generate(baseService({ options: { token: "super-secret-abc" } }), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.env).toContainEqual({ name: "SRH_TOKEN", value: "super-secret-abc" });
    });

    it("exposes both the REST port and the raw Redis port on the Service", () => {
        const result = recipe.generate(baseService(), "ns");
        const service = result.services[0];
        expect(service?.spec?.ports).toEqual([
            { name: "http", port: 8000, targetPort: 8000 },
            { name: "redis", port: 6379, targetPort: 6379 },
        ]);
    });

    it("uses an unauthenticated GET / readiness probe on the REST port", () => {
        // SRH serves a 200 at GET / with no auth; deeper than a TCP probe
        // since the BEAM port binds before the app is serving.
        const result = recipe.generate(baseService(), "ns");
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.readinessProbe?.httpGet?.path).toBe("/");
        expect(proxy?.readinessProbe?.httpGet?.port).toBe(8000);
        expect(proxy?.readinessProbe?.tcpSocket).toBeUndefined();
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
        const result = recipe.generate(
            baseService({ resources: { cpu: "500m", memoryRequest: "512Mi", memoryLimit: "1Gi" } }),
            "ns",
        );
        const proxy = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "proxy");
        expect(proxy?.resources?.requests).toEqual({ cpu: "500m", memory: "512Mi" });
        expect(proxy?.resources?.limits).toEqual({ memory: "1Gi" });
    });

    it("gives Redis a small fixed budget independent of config.resources", () => {
        const result = recipe.generate(
            baseService({ resources: { cpu: "2000m", memoryRequest: "2Gi", memoryLimit: "2Gi" } }),
            "ns",
        );
        const redis = result.deployments[0]?.spec?.template?.spec?.containers?.find((c) => c.name === "redis");
        expect(redis?.resources?.requests).toEqual({ cpu: "50m", memory: "64Mi" });
        expect(redis?.resources?.limits).toEqual({ memory: "128Mi" });
    });
});
