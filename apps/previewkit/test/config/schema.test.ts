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
        // resources is deprecated; omitting it yields the app-tier standard.
        expect(result.apps[0].resources).toEqual({ cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" });
    });

    describe("replicas (clamped)", () => {
        it("keeps values at or below the cap", () => {
            const result = previewConfigSchema.parse({
                version: 1,
                apps: [{ name: "web", port: 3000, replicas: 2 }],
            });
            expect(result.apps[0].replicas).toBe(2);
        });

        it("clamps values above the cap instead of rejecting", () => {
            const result = previewConfigSchema.parse({
                version: 1,
                apps: [{ name: "web", port: 3000, replicas: 50 }],
            });
            expect(result.apps[0].replicas).toBe(3);
        });
    });

    describe("resources (deprecated)", () => {
        it("yields the app-tier standard when omitted", () => {
            const result = previewConfigSchema.parse(validConfig);
            expect(result.apps[0].resources).toEqual({ cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" });
        });

        it("ignores any explicit cpu/memory and still yields the tiered standards", () => {
            const result = previewConfigSchema.parse({
                version: 1,
                apps: [{ name: "web", port: 3000, resources: { cpu: "2", memory: "8Gi" } }],
                services: [{ name: "db", recipe: "postgres", resources: { cpu: "4", memory: "8Gi" } }],
            });
            expect(result.apps[0].resources).toEqual({ cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" });
            expect(result.services[0].resources).toEqual({
                cpu: "100m",
                memoryRequest: "256Mi",
                memoryLimit: "1Gi",
            });
        });

        it("still validates a config that sets resources (backward compatibility)", () => {
            const result = previewConfigSchema.safeParse({
                version: 1,
                apps: [{ name: "web", port: 3000, resources: { cpu: "500m", memory: "512Mi" } }],
            });
            expect(result.success).toBe(true);
        });
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

    describe("primary field", () => {
        it("parses primary: true", () => {
            const result = previewConfigSchema.safeParse({
                version: 1,
                apps: [{ name: "web", port: 3000, primary: true }],
            });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.apps[0].primary).toBe(true);
        });

        it("parses primary: false", () => {
            const result = previewConfigSchema.safeParse({
                version: 1,
                apps: [{ name: "web", port: 3000, primary: false }],
            });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.apps[0].primary).toBe(false);
        });

        it("is undefined when primary is absent", () => {
            const result = previewConfigSchema.safeParse({
                version: 1,
                apps: [{ name: "web", port: 3000 }],
            });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.apps[0].primary).toBeUndefined();
        });

        it("rejects primary with a non-boolean value", () => {
            const result = previewConfigSchema.safeParse({
                version: 1,
                apps: [{ name: "web", port: 3000, primary: "yes" }],
            });
            expect(result.success).toBe(false);
        });
    });

    describe("addons", () => {
        it("defaults to empty array when absent", () => {
            const result = previewConfigSchema.safeParse({
                version: 1,
                apps: [{ name: "web", port: 3000 }],
            });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.addons).toEqual([]);
        });

        it("parses a Neon addon entry", () => {
            const result = previewConfigSchema.safeParse({
                version: 1,
                apps: [{ name: "web", port: 3000 }],
                addons: [
                    {
                        name: "db",
                        provider: "neon",
                        auth_secret: "neon-api-key",
                        options: { project_id: "epic-water-12345", parent_branch: "main" },
                    },
                ],
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.addons).toHaveLength(1);
                expect(result.data.addons[0]).toMatchObject({
                    name: "db",
                    provider: "neon",
                    auth_secret: "neon-api-key",
                });
            }
        });

        it("rejects addon with empty auth_secret", () => {
            const result = previewConfigSchema.safeParse({
                version: 1,
                apps: [{ name: "web", port: 3000 }],
                addons: [{ name: "db", provider: "neon", auth_secret: "" }],
            });
            expect(result.success).toBe(false);
        });

        it("rejects addon with empty provider", () => {
            const result = previewConfigSchema.safeParse({
                version: 1,
                apps: [{ name: "web", port: 3000 }],
                addons: [{ name: "db", provider: "", auth_secret: "key" }],
            });
            expect(result.success).toBe(false);
        });

        it("rejects names colliding across apps + services + addons", () => {
            // Catches the surprising case where an addon shadows an app the
            // template engine would otherwise have resolved against — uniqueness
            // is enforced at config-parse time, not silently at resolve time.
            const result = previewConfigSchema.safeParse({
                version: 1,
                apps: [{ name: "db", port: 3000 }],
                addons: [{ name: "db", provider: "neon", auth_secret: "key" }],
            });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues.some((i) => i.message.includes("must be unique"))).toBe(true);
            }
        });

        it("rejects names colliding between two addons", () => {
            const result = previewConfigSchema.safeParse({
                version: 1,
                apps: [{ name: "web", port: 3000 }],
                addons: [
                    { name: "db", provider: "neon", auth_secret: "k1" },
                    { name: "db", provider: "neon", auth_secret: "k2" },
                ],
            });
            expect(result.success).toBe(false);
        });
    });
});
