import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../../src/config/schema";
import { RedisRecipe } from "../../src/recipes/redis-recipe";
import { ValkeyRecipe } from "../../src/recipes/valkey-recipe";

const baseService = (overrides: Partial<ServiceConfig> = {}): ServiceConfig => ({
    name: "cache",
    recipe: "redis",
    env: { FOO: "bar" },
    options: {},
    resources: { cpu: "250m", memoryRequest: "256Mi", memoryLimit: "512Mi" },
    ...overrides,
});

describe("RedisRecipe", () => {
    const recipe = new RedisRecipe();

    it("produces the expected Deployment + Service shape", () => {
        const result = recipe.generate(baseService(), "ns");
        const container = result.deployments[0]?.spec?.template?.spec?.containers?.[0];

        expect(container?.image).toBe("redis:7-alpine");
        expect(container?.ports).toEqual([{ name: "primary", containerPort: 6379 }]);
        expect(container?.readinessProbe).toEqual({
            exec: { command: ["redis-cli", "ping"] },
            initialDelaySeconds: 3,
            periodSeconds: 5,
        });
        expect(container?.env).toEqual([{ name: "FOO", value: "bar" }]);
        expect(container?.resources).toEqual({
            requests: { cpu: "250m", memory: "256Mi" },
            limits: { memory: "512Mi" },
        });

        expect(result.services[0]?.spec?.ports).toEqual([{ name: "primary", port: 6379, targetPort: 6379 }]);
    });

    it("honors the version override", () => {
        const result = recipe.generate(baseService({ version: "8-alpine" }), "ns");
        expect(result.deployments[0]?.spec?.template?.spec?.containers?.[0]?.image).toBe("redis:8-alpine");
    });

    it("connectionInfo returns the service name, redis port and redis:// URL", () => {
        expect(recipe.connectionInfo(baseService())).toEqual({
            host: "cache",
            port: 6379,
            url: "redis://cache:6379",
        });
    });
});

describe("ValkeyRecipe", () => {
    const recipe = new ValkeyRecipe();

    it("produces the expected Deployment + Service shape", () => {
        const result = recipe.generate(baseService({ recipe: "valkey" }), "ns");
        const container = result.deployments[0]?.spec?.template?.spec?.containers?.[0];

        expect(container?.image).toBe("valkey/valkey:8-alpine");
        expect(container?.ports).toEqual([{ name: "primary", containerPort: 6379 }]);
        expect(container?.readinessProbe).toEqual({
            exec: { command: ["valkey-cli", "ping"] },
            initialDelaySeconds: 3,
            periodSeconds: 5,
        });
    });
});
