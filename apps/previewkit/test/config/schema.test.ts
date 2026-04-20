import { describe, it, expect } from "vitest";
import { previewConfigSchema } from "../../src/config/schema.js";

describe("previewConfigSchema", () => {
    const validConfig = {
        version: 1,
        apps: [
            {
                name: "web",
                path: "./apps/web",
                port: 3000,
            },
        ],
    };

    it("parses a minimal valid config", () => {
        const result = previewConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.apps).toHaveLength(1);
            expect(result.data.apps[0].name).toBe("web");
            expect(result.data.services).toEqual([]);
            expect(result.data.hooks.post_deploy).toEqual([]);
        }
    });

    it("parses a full monorepo config", () => {
        const config = {
            version: 1,
            domain: "preview.example.com",
            registry: "ghcr.io/my-org",
            apps: [
                {
                    name: "web",
                    path: "./apps/web",
                    port: 3000,
                    env: {
                        API_URL: "http://{{api.host}}:{{api.port}}",
                        DATABASE_URL: "postgresql://preview:preview@{{db.host}}:5432/preview",
                    },
                    health_check: "/health",
                },
                {
                    name: "api",
                    path: "./apps/api",
                    port: 4000,
                    dockerfile: "./apps/api/Dockerfile",
                    env: {
                        DATABASE_URL: "postgresql://preview:preview@{{db.host}}:5432/preview",
                    },
                },
            ],
            services: [
                { name: "db", recipe: "postgres", version: "16" },
                { name: "cache", recipe: "redis" },
            ],
            hooks: {
                post_deploy: [{ app: "api", command: "npx prisma migrate deploy" }],
            },
        };

        const result = previewConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.apps).toHaveLength(2);
            expect(result.data.services).toHaveLength(2);
            expect(result.data.hooks.post_deploy).toHaveLength(1);
        }
    });

    it("applies default values", () => {
        const result = previewConfigSchema.parse(validConfig);
        expect(result.apps[0].replicas).toBe(1);
        expect(result.apps[0].build_args).toEqual({});
        expect(result.apps[0].env).toEqual({});
        expect(result.apps[0].resources).toEqual({ cpu: "250m", memory: "256Mi" });
    });

    it("rejects missing version", () => {
        const result = previewConfigSchema.safeParse({
            apps: [{ name: "web", port: 3000 }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects wrong version number", () => {
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [{ name: "web", port: 3000 }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects empty apps array", () => {
        const result = previewConfigSchema.safeParse({
            version: 1,
            apps: [],
        });
        expect(result.success).toBe(false);
    });

    it("rejects invalid app name (uppercase)", () => {
        const result = previewConfigSchema.safeParse({
            version: 1,
            apps: [{ name: "MyApp", port: 3000 }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects invalid app name (starts with dash)", () => {
        const result = previewConfigSchema.safeParse({
            version: 1,
            apps: [{ name: "-web", port: 3000 }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects missing port", () => {
        const result = previewConfigSchema.safeParse({
            version: 1,
            apps: [{ name: "web" }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects negative port", () => {
        const result = previewConfigSchema.safeParse({
            version: 1,
            apps: [{ name: "web", port: -1 }],
        });
        expect(result.success).toBe(false);
    });
});
