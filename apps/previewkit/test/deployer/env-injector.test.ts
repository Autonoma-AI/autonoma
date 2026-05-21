import { describe, it, expect } from "vitest";
import type { AppConfig, ServiceConfig } from "../../src/config/schema";
import { EnvInjector } from "../../src/deployer/env-injector";
import { RecipeRegistry } from "../../src/recipes/recipe-registry";

const registry = new RecipeRegistry();
const injector = new EnvInjector(registry);

const defaultContext = { pr: "42", namespace: "preview-acme-corp-my-repo-pr-42", owner: "acme-corp" };
const defaultPublicUrlInfo = { domain: "preview.autonoma.app", repoSlug: "acme-corp-my-repo", prNumber: 42 };

const apps: AppConfig[] = [
    {
        name: "web",
        path: "./apps/web",
        port: 3000,
        build_args: {},
        env: {},
        replicas: 1,
        resources: { cpu: "250m", memory: "256Mi" },
    },
    {
        name: "api",
        path: "./apps/api",
        port: 4000,
        build_args: {},
        env: {},
        replicas: 1,
        resources: { cpu: "250m", memory: "256Mi" },
    },
];

const services: ServiceConfig[] = [
    {
        name: "db",
        recipe: "postgres",
        env: {},
        resources: { cpu: "250m", memory: "256Mi" },
    },
    {
        name: "cache",
        recipe: "redis",
        env: {},
        resources: { cpu: "250m", memory: "256Mi" },
    },
];

describe("EnvInjector", () => {
    it("resolves service host and port templates", () => {
        const configEnv = {
            DATABASE_URL: "postgresql://preview:preview@{{db.host}}:{{db.port}}/preview",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["DATABASE_URL"]).toBe("postgresql://preview:preview@db:5432/preview");
    });

    it("resolves app host and port templates", () => {
        const configEnv = {
            API_URL: "http://{{api.host}}:{{api.port}}",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["API_URL"]).toBe("http://api:4000");
    });

    it("resolves redis templates", () => {
        const configEnv = {
            REDIS_URL: "redis://{{cache.host}}:{{cache.port}}",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["REDIS_URL"]).toBe("redis://cache:6379");
    });

    it("passes through non-template values unchanged", () => {
        const configEnv = {
            NODE_ENV: "production",
            LOG_LEVEL: "info",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved).toEqual(configEnv);
    });

    it("handles multiple templates in one value", () => {
        const configEnv = {
            CONFIG: "{{db.host}}:{{db.port}},{{cache.host}}:{{cache.port}}",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["CONFIG"]).toBe("db:5432,cache:6379");
    });

    it("throws on unknown service reference", () => {
        const configEnv = {
            URL: "http://{{unknown.host}}:{{unknown.port}}",
        };

        expect(() =>
            injector.resolve(configEnv, apps, services, "preview-ns", defaultContext, defaultPublicUrlInfo),
        ).toThrow(/Unknown service\/app reference/);
    });

    it("resolves {{pr}} template", () => {
        const configEnv = {
            TASK_QUEUE: "pr-{{pr}}-default",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["TASK_QUEUE"]).toBe("pr-42-default");
    });

    it("resolves {{namespace}} template", () => {
        const configEnv = {
            K8S_NAMESPACE: "{{namespace}}",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["K8S_NAMESPACE"]).toBe("preview-acme-corp-my-repo-pr-42");
    });

    it("resolves {{owner}} template", () => {
        const configEnv = {
            ORG: "{{owner}}",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["ORG"]).toBe("acme-corp");
    });

    it("resolves Temporal service to the in-namespace dev cluster", () => {
        // The temporal recipe now deploys a single-binary dev cluster per
        // preview, so `{{temporal.host}}` resolves to the in-namespace
        // service name (just `temporal`), not an external shared address.
        const temporalServices: ServiceConfig[] = [
            ...services,
            {
                name: "temporal",
                recipe: "temporal",
                env: {},
                resources: { cpu: "250m", memory: "256Mi" },
            },
        ];

        const configEnv = {
            TEMPORAL_ADDRESS: "{{temporal.host}}:{{temporal.port}}",
            TEMPORAL_NAMESPACE: "preview-pr-{{pr}}",
            TEMPORAL_TASK_QUEUE: "pr-{{pr}}-default",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            temporalServices,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["TEMPORAL_ADDRESS"]).toBe("temporal:7233");
        expect(resolved["TEMPORAL_NAMESPACE"]).toBe("preview-pr-42");
        expect(resolved["TEMPORAL_TASK_QUEUE"]).toBe("pr-42-default");
    });

    it("mixes context variables with service templates in one value", () => {
        const configEnv = {
            WORKER_ID: "{{owner}}-pr-{{pr}}-{{api.host}}",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["WORKER_ID"]).toBe("acme-corp-pr-42-api");
    });

    it("resolves hyphenated service names (regression: was silently dropped by \\w+)", () => {
        // The schema allows names like `api-gateway` but the old regex used
        // `\w+` which stops at the hyphen, so the template never matched.
        const hyphenatedServices: ServiceConfig[] = [
            ...services,
            {
                name: "api-gateway",
                recipe: "api-gateway",
                env: {},
                options: { routes: [{ path: "/", target: "web", strip_prefix: false }] },
                resources: { cpu: "250m", memory: "256Mi" },
            },
        ];

        const configEnv = {
            GATEWAY_URL: "http://{{api-gateway.host}}:{{api-gateway.port}}",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            hyphenatedServices,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["GATEWAY_URL"]).toBe("http://api-gateway:80");
    });

    it("returns an empty object when there is no config env", () => {
        const resolved = injector.resolve({}, apps, services, "preview-ns", defaultContext, defaultPublicUrlInfo);
        expect(resolved).toEqual({});
    });

    it("passes through values that look templated but do not match the grammar", () => {
        // `{{api.foo}}` — wrong field. `{{ pr }}` — internal whitespace.
        // `{{api}}`    — missing .host/.port. None of these should resolve;
        //               all should pass through verbatim.
        const configEnv = {
            LITERAL_BRACES: "use {{api.foo}} or {{ pr }} or {{api}} as-is",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["LITERAL_BRACES"]).toBe("use {{api.foo}} or {{ pr }} or {{api}} as-is");
    });

    it("resolves {{name.url}} to the public preview URL for apps", () => {
        const configEnv = {
            VITE_API_URL: "{{api.url}}",
            VITE_WEB_URL: "{{web.url}}",
        };

        const resolved = injector.resolve(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        // hostname = `<app>-pr-<N>-<slug>.<domain>`, scheme `https://`
        expect(resolved["VITE_API_URL"]).toBe("https://api-pr-42-acme-corp-my-repo.preview.autonoma.app");
        expect(resolved["VITE_WEB_URL"]).toBe("https://web-pr-42-acme-corp-my-repo.preview.autonoma.app");
    });

    it("throws when {{name.url}} is used on a service (no public URL)", () => {
        const configEnv = {
            FAIL: "postgres://{{db.url}}",
        };

        expect(() =>
            injector.resolve(configEnv, apps, services, "preview-ns", defaultContext, defaultPublicUrlInfo),
        ).toThrow(/only available for apps/);
    });

    it("applyTemplates exposes the same grammar without secret merging (used for build_args)", () => {
        // build_args has no secret-store concept — applyTemplates skips that
        // step. Should still resolve `.url`, `{{pr}}`, etc.
        const buildArgs = {
            VITE_API_URL: "{{api.url}}",
            BUILD_TARGET: "pr-{{pr}}",
            STATIC: "no-template-here",
        };

        const resolved = injector.applyTemplates(
            buildArgs,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["VITE_API_URL"]).toBe("https://api-pr-42-acme-corp-my-repo.preview.autonoma.app");
        expect(resolved["BUILD_TARGET"]).toBe("pr-42");
        expect(resolved["STATIC"]).toBe("no-template-here");
    });
});
