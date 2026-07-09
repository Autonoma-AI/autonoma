import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../../src/config/schema";
import { type DockerImageOptions, DockerImageRecipe } from "../../src/recipes/docker-image-recipe";

const baseService = (overrides: Partial<ServiceConfig> = {}): ServiceConfig => ({
    name: "svc",
    recipe: "docker-image",
    env: {},
    options: {},
    resources: { cpu: "100m", memory: "128Mi" },
    ...overrides,
});

describe("DockerImageRecipe", () => {
    const recipe = new DockerImageRecipe();

    it("generates a Deployment and Service for an image with a port", () => {
        const config = baseService({
            options: {
                image: "ghcr.io/permify/permify:latest",
                port_definition: { port: 3476 },
                command: ["serve"],
                args: ["--database-engine=memory"],
            },
        });
        const result = recipe.generate(config, "ns");

        expect(result.deployments).toHaveLength(1);
        expect(result.services).toHaveLength(1);

        const container = result.deployments[0]?.spec?.template?.spec?.containers?.[0];
        expect(container?.image).toBe("ghcr.io/permify/permify:latest");
        expect(container?.command).toEqual(["serve"]);
        expect(container?.args).toEqual(["--database-engine=memory"]);
        expect(container?.ports).toEqual([{ name: "primary", containerPort: 3476 }]);
        expect(container?.readinessProbe).toBeUndefined();

        const svc = result.services[0];
        expect(svc?.spec?.ports).toEqual([{ name: "primary", port: 3476, targetPort: 3476 }]);
    });

    it("uses the explicit primary port name when provided", () => {
        const config = baseService({
            options: { image: "my/app:1", port_definition: { name: "grpc", port: 7233 } },
        });
        const result = recipe.generate(config, "ns");
        expect(result.deployments[0]?.spec?.template?.spec?.containers?.[0]?.ports).toEqual([
            { name: "grpc", containerPort: 7233 },
        ]);
        expect(result.services[0]?.spec?.ports).toEqual([{ name: "grpc", port: 7233, targetPort: 7233 }]);
    });

    it("connectionInfo returns host and port", () => {
        const config = baseService({ options: { image: "x:1", port_definition: { port: 8080 } } });
        expect(recipe.connectionInfo(config)).toEqual({ host: "svc", port: 8080 });
    });

    it("supports exec readiness probe", () => {
        const config = baseService({
            options: {
                image: "redis:7-alpine",
                port_definition: { port: 6379 },
                readiness: {
                    exec: { command: ["redis-cli", "ping"] },
                    initial_delay_seconds: 3,
                    period_seconds: 5,
                },
            },
        });
        const probe = recipe.generate(config, "ns").deployments[0]?.spec?.template?.spec?.containers?.[0]
            ?.readinessProbe;
        expect(probe).toEqual({
            exec: { command: ["redis-cli", "ping"] },
            initialDelaySeconds: 3,
            periodSeconds: 5,
        });
    });

    it("supports http readiness probe", () => {
        const config = baseService({
            options: {
                image: "my/app:1",
                port_definition: { port: 8080 },
                readiness: { http: { path: "/health", port_definition: { port: 8080 } } },
            },
        });
        const probe = recipe.generate(config, "ns").deployments[0]?.spec?.template?.spec?.containers?.[0]
            ?.readinessProbe;
        expect(probe).toEqual({ httpGet: { path: "/health", port: 8080 } });
    });

    it("supports tcp readiness probe", () => {
        const config = baseService({
            options: {
                image: "my/app:1",
                port_definition: { port: 7233 },
                readiness: { tcp: { port_definition: { port: 7233 } } },
            },
        });
        const probe = recipe.generate(config, "ns").deployments[0]?.spec?.template?.spec?.containers?.[0]
            ?.readinessProbe;
        expect(probe).toEqual({ tcpSocket: { port: 7233 } });
    });

    it("emits named ports when additional_ports is set", () => {
        const config = baseService({
            options: {
                image: "my/app:1",
                port_definition: { port: 7233 },
                additional_ports: [{ name: "ui", port: 8233 }],
            },
        });
        const result = recipe.generate(config, "ns");
        const containerPorts = result.deployments[0]?.spec?.template?.spec?.containers?.[0]?.ports;
        expect(containerPorts).toEqual([
            { name: "primary", containerPort: 7233 },
            { name: "ui", containerPort: 8233 },
        ]);
        expect(result.services[0]?.spec?.ports).toEqual([
            { name: "primary", port: 7233, targetPort: 7233 },
            { name: "ui", port: 8233, targetPort: 8233 },
        ]);
    });

    it("throws a descriptive error when image is missing", () => {
        const config = baseService({ options: { port_definition: { port: 1234 } } });
        expect(() => recipe.generate(config, "ns")).toThrow(/Invalid options for docker-image recipe/);
    });

    it("throws when readiness specifies more than one probe type", () => {
        const config = baseService({
            options: {
                image: "x:1",
                port_definition: { port: 80 },
                readiness: {
                    http: { path: "/", port_definition: { port: 80 } },
                    tcp: { port_definition: { port: 80 } },
                },
            },
        });
        expect(() => recipe.generate(config, "ns")).toThrow(/Invalid options for docker-image recipe/);
    });

    it("typedGenerate skips parsing and accepts the typed shape directly", () => {
        // Sanity check that the typed entry point works for tests / wrappers.
        const config: ServiceConfig<DockerImageOptions> = {
            ...baseService(),
            options: {
                image: "x:1",
                port_definition: { port: 9000 },
                additional_ports: [],
            },
        };
        const result = recipe.typedGenerate(config, "ns");
        expect(result.deployments).toHaveLength(1);
        expect(result.services[0]?.spec?.ports).toEqual([{ name: "primary", port: 9000, targetPort: 9000 }]);
    });
});
