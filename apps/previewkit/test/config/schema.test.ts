import { describe, it, expect } from "vitest";
import { previewConfigSchema, trustedPreviewConfigSchema } from "../../src/config/schema";

describe("previewConfigSchema", () => {
    const validConfig = {
        version: 2,
        apps: [
            {
                name: "web",
                repository: "acme/web",
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
            expect(result.data.apps[0].repository).toBe("acme/web");
            expect(result.data.services).toEqual([]);
            expect(result.data.hooks.post_deploy).toEqual([]);
        }
    });

    it("parses a full monorepo config", () => {
        const config = {
            version: 2,
            domain: "preview.example.com",
            registry: "ghcr.io/my-org",
            apps: [
                {
                    name: "web",
                    repository: "acme/web",
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
                    repository: "acme/web",
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
        expect(result.apps[0].connections).toEqual([]);
        expect(result.apps[0].build_secrets).toEqual([]);
        expect(result.repositories).toEqual([]);
        expect(result.branch_convention).toBeUndefined();
        // On the untrusted schema, omitting resources yields the app-tier standard.
        expect(result.apps[0].resources).toEqual({ cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" });
    });

    describe("repository field", () => {
        it("rejects an app with no repository", () => {
            const result = previewConfigSchema.safeParse({
                version: 2,
                apps: [{ name: "web", port: 3000 }],
            });
            expect(result.success).toBe(false);
        });

        it("rejects a repository that is not an owner/repo full name", () => {
            for (const repository of ["acme", "acme/", "/web", "acme/we b", "acme/web/extra"]) {
                const result = previewConfigSchema.safeParse({
                    version: 2,
                    apps: [{ name: "web", repository, port: 3000 }],
                });
                expect(result.success).toBe(false);
            }
        });

        it("accepts apps spanning multiple repositories", () => {
            const result = previewConfigSchema.safeParse({
                version: 2,
                apps: [
                    { name: "web", repository: "acme/web", port: 3000 },
                    { name: "api", repository: "acme/api", port: 4000 },
                ],
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.apps.map((app) => app.repository)).toEqual(["acme/web", "acme/api"]);
            }
        });
    });

    describe("repositories and branch_convention", () => {
        it("defaults a repositories entry's fallback_branch to main", () => {
            const result = previewConfigSchema.parse({
                version: 2,
                apps: [{ name: "api", repository: "acme/api", port: 4000 }],
                repositories: [{ repo: "acme/api" }],
            });
            expect(result.repositories).toEqual([{ repo: "acme/api", fallback_branch: "main" }]);
        });

        it("carries a deploy-time sha through a re-parse", () => {
            const result = previewConfigSchema.parse({
                version: 2,
                apps: [{ name: "api", repository: "acme/api", port: 4000 }],
                repositories: [{ repo: "acme/api", fallback_branch: "develop", sha: "abc123" }],
            });
            expect(result.repositories[0]).toEqual({ repo: "acme/api", fallback_branch: "develop", sha: "abc123" });
        });

        it("rejects duplicate repositories entries for the same repo", () => {
            const result = previewConfigSchema.safeParse({
                version: 2,
                apps: [{ name: "api", repository: "acme/api", port: 4000 }],
                repositories: [{ repo: "acme/api" }, { repo: "acme/api", fallback_branch: "develop" }],
            });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues.some((i) => i.message.includes("more than one settings entry"))).toBe(true);
            }
        });

        it("parses a regex branch_convention", () => {
            const result = previewConfigSchema.parse({
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000 }],
                branch_convention: { type: "regex", pattern: "^feature/(.+)$", replacement: "preview/$1" },
            });
            expect(result.branch_convention).toEqual({
                type: "regex",
                pattern: "^feature/(.+)$",
                replacement: "preview/$1",
            });
        });

        it("rejects a regex branch_convention with an invalid pattern", () => {
            const result = previewConfigSchema.safeParse({
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000 }],
                branch_convention: { type: "regex", pattern: "([", replacement: "x" },
            });
            expect(result.success).toBe(false);
        });
    });

    describe("resources (ignored on the untrusted schema)", () => {
        it("yields the app-tier standard when omitted", () => {
            const result = previewConfigSchema.parse(validConfig);
            expect(result.apps[0].resources).toEqual({ cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" });
        });

        it("ignores explicit app and service resource input", () => {
            const result = previewConfigSchema.parse({
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000, resources: { cpu: "500m", memory: "2Gi" } }],
                services: [{ name: "db", recipe: "postgres", resources: { cpu: "250m", memory: "2Gi" } }],
            });
            expect(result.apps[0].resources).toEqual({ cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" });
            expect(result.services[0].resources).toEqual({
                cpu: "100m",
                memoryRequest: "256Mi",
                memoryLimit: "1Gi",
            });
        });

        it("ignores the normalized memoryRequest/memoryLimit keys too", () => {
            const result = previewConfigSchema.parse({
                version: 2,
                apps: [
                    {
                        name: "web",
                        repository: "acme/web",
                        port: 3000,
                        resources: { cpu: "2", memoryRequest: "8Gi", memoryLimit: "16Gi" },
                    },
                ],
            });
            expect(result.apps[0].resources).toEqual({ cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" });
        });

        it("still validates a config that sets resources (backward compatibility)", () => {
            const result = previewConfigSchema.safeParse({
                version: 2,
                apps: [
                    { name: "web", repository: "acme/web", port: 3000, resources: { cpu: "500m", memory: "512Mi" } },
                ],
            });
            expect(result.success).toBe(true);
        });
    });

    describe("resources (honored for trusted config revisions)", () => {
        it("honors explicit cpu/memory, using memory for both request and limit", () => {
            const result = trustedPreviewConfigSchema.parse({
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000, resources: { cpu: "2", memory: "4Gi" } }],
                services: [{ name: "db", recipe: "postgres", resources: { cpu: "1", memory: "2Gi" } }],
            });
            expect(result.apps[0].resources).toEqual({ cpu: "2", memoryRequest: "4Gi", memoryLimit: "4Gi" });
            expect(result.services[0].resources).toEqual({ cpu: "1", memoryRequest: "2Gi", memoryLimit: "2Gi" });
        });

        it("falls back to the tier standard for any field the document omits", () => {
            const result = trustedPreviewConfigSchema.parse({
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000, resources: { cpu: "2" } }],
            });
            expect(result.apps[0].resources).toEqual({ cpu: "2", memoryRequest: "512Mi", memoryLimit: "1Gi" });
        });

        it("yields the standard tier when resources is omitted", () => {
            const result = trustedPreviewConfigSchema.parse({
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000 }],
            });
            expect(result.apps[0].resources).toEqual({ cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" });
        });

        it("is idempotent when re-parsing an already-resolved config (deploy round-trip)", () => {
            const once = trustedPreviewConfigSchema.parse({
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000, resources: { cpu: "2", memory: "4Gi" } }],
            });
            // The merged config crosses the runner boundary as JSON and is
            // re-parsed at deploy time; the second parse must preserve the values.
            const twice = trustedPreviewConfigSchema.parse(JSON.parse(JSON.stringify(once)));
            expect(twice.apps[0].resources).toEqual(once.apps[0].resources);
        });
    });

    it("rejects missing version", () => {
        const result = previewConfigSchema.safeParse({
            apps: [{ name: "web", repository: "acme/web", port: 3000 }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects wrong version number", () => {
        const result = previewConfigSchema.safeParse({
            version: 1,
            apps: [{ name: "web", repository: "acme/web", port: 3000 }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects empty apps array", () => {
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [],
        });
        expect(result.success).toBe(false);
    });

    it("rejects invalid app name (uppercase)", () => {
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [{ name: "MyApp", repository: "acme/web", port: 3000 }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects invalid app name (starts with dash)", () => {
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [{ name: "-web", repository: "acme/web", port: 3000 }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects missing port", () => {
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [{ name: "web", repository: "acme/web" }],
        });
        expect(result.success).toBe(false);
    });

    it("rejects negative port", () => {
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [{ name: "web", repository: "acme/web", port: -1 }],
        });
        expect(result.success).toBe(false);
    });

    describe("primary field", () => {
        it("parses primary: true", () => {
            const result = previewConfigSchema.safeParse({
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000, primary: true }],
            });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.apps[0].primary).toBe(true);
        });

        it("parses primary: false", () => {
            const result = previewConfigSchema.safeParse({
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000, primary: false }],
            });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.apps[0].primary).toBe(false);
        });

        it("is undefined when primary is absent", () => {
            const result = previewConfigSchema.safeParse({
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000 }],
            });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.apps[0].primary).toBeUndefined();
        });

        it("rejects primary with a non-boolean value", () => {
            const result = previewConfigSchema.safeParse({
                version: 2,
                apps: [{ name: "web", repository: "acme/web", port: 3000, primary: "yes" }],
            });
            expect(result.success).toBe(false);
        });
    });

    it("rejects names colliding across apps and services", () => {
        const result = previewConfigSchema.safeParse({
            version: 2,
            apps: [{ name: "db", repository: "acme/web", port: 3000 }],
            services: [{ name: "db", recipe: "postgres" }],
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.some((i) => i.message.includes("must be unique"))).toBe(true);
        }
    });
});
