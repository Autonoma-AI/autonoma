import { describe, it, expect } from "vitest";
import type { AppConfig, ServiceConfig } from "../../src/config/schema";
import { EnvInjector } from "../../src/deployer/env-injector";
import { buildAppHostname } from "../../src/deployer/resource-factory";
import { RecipeRegistry } from "../../src/recipes/recipe-registry";

const registry = new RecipeRegistry();
const injector = new EnvInjector(registry);

const defaultContext = { pr: "42", namespace: "preview-acme-corp-my-repo-pr-42", owner: "acme-corp" };
const defaultPublicUrlInfo = {
    domain: "preview.autonoma.app",
    repoFullName: "acme-corp/my-repo",
    prNumber: 42,
    secret: "test-secret",
};

const apps: AppConfig[] = [
    {
        name: "web",
        repository: "acme-corp/my-repo",
        path: "./apps/web",
        port: 3000,
        connections: [],
        resources: { cpu: "250m", memory: "512Mi" },
        build_secrets: [],
    },
    {
        name: "api",
        repository: "acme-corp/my-repo",
        path: "./apps/api",
        port: 4000,
        connections: [],
        resources: { cpu: "250m", memory: "512Mi" },
        build_secrets: [],
    },
];

const services: ServiceConfig[] = [
    {
        name: "db",
        recipe: "postgres",
        resources: { cpu: "250m", memory: "512Mi" },
        options: {},
    },
    {
        name: "cache",
        recipe: "redis",
        resources: { cpu: "250m", memory: "512Mi" },
        options: {},
    },
];

describe("EnvInjector", () => {
    it("resolveConnections resolves each connection's template value (single-token, composite, and cross-app)", () => {
        const resolved = injector.resolveConnections(
            [
                { key: "DATABASE_URL", value: "{{db.url}}", build_time: false },
                {
                    key: "MONGO_URI",
                    value: "mongodb://{{db.host}}:{{db.port}}/preview?replicaSet=rs0",
                    build_time: false,
                },
                { key: "API_URL", value: "{{api.url}}", build_time: true },
            ],
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["DATABASE_URL"]).toBe("postgresql://preview:preview@db:5432/preview");
        // The composite template is the case a single target/property could not express.
        expect(resolved["MONGO_URI"]).toBe("mongodb://db:5432/preview?replicaSet=rs0");
        expect(resolved["API_URL"]).toBe(
            `https://${buildAppHostname("api", 42, "acme-corp/my-repo", "preview.autonoma.app", "test-secret")}`,
        );
    });

    it("resolves service host and port templates", () => {
        const configEnv = {
            DATABASE_URL: "postgresql://preview:preview@{{db.host}}:{{db.port}}/preview",
        };

        const resolved = injector.applyTemplates(
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

        const resolved = injector.applyTemplates(
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

        const resolved = injector.applyTemplates(
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

        const resolved = injector.applyTemplates(
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

        const resolved = injector.applyTemplates(
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
            injector.applyTemplates(configEnv, apps, services, "preview-ns", defaultContext, defaultPublicUrlInfo),
        ).toThrow(/Unknown reference/);
    });

    it("resolves {{pr}} template", () => {
        const configEnv = {
            TASK_QUEUE: "pr-{{pr}}-default",
        };

        const resolved = injector.applyTemplates(
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

        const resolved = injector.applyTemplates(
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

        const resolved = injector.applyTemplates(
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
                resources: { cpu: "250m", memory: "512Mi" },
                options: undefined,
            },
        ];

        const configEnv = {
            TEMPORAL_ADDRESS: "{{temporal.host}}:{{temporal.port}}",
            TEMPORAL_NAMESPACE: "preview-pr-{{pr}}",
            TEMPORAL_TASK_QUEUE: "pr-{{pr}}-default",
        };

        const resolved = injector.applyTemplates(
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

        const resolved = injector.applyTemplates(
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
                resources: { cpu: "250m", memory: "512Mi" },
            },
        ];

        const configEnv = {
            GATEWAY_URL: "http://{{api-gateway.host}}:{{api-gateway.port}}",
        };

        const resolved = injector.applyTemplates(
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
        const resolved = injector.applyTemplates(
            {},
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved).toEqual({});
    });

    it("passes through values that look templated but do not match the grammar", () => {
        // `{{ pr }}`            — internal whitespace.
        // `{{api}}`             — missing .host/.port.
        // `{{api.foo}}`         — field is not host/port/url/hostname.
        // `{{api.host.extra}}`  — extra dot after a valid-looking match prefix
        //                         keeps the `}}` from being adjacent, so the
        //                         regex never anchors.
        const configEnv = {
            LITERAL_BRACES: "use {{ pr }} or {{api}} or {{api.foo}} or {{api.host.extra}} as-is",
        };

        const resolved = injector.applyTemplates(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["LITERAL_BRACES"]).toBe("use {{ pr }} or {{api}} or {{api.foo}} or {{api.host.extra}} as-is");
    });

    it("resolves {{name.url}} to the public preview URL for apps", () => {
        const configEnv = {
            VITE_API_URL: "{{api.url}}",
            VITE_WEB_URL: "{{web.url}}",
        };

        const resolved = injector.applyTemplates(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        const { domain, repoFullName, prNumber, secret } = defaultPublicUrlInfo;
        expect(resolved["VITE_API_URL"]).toBe(
            `https://${buildAppHostname("api", prNumber, repoFullName, domain, secret)}`,
        );
        expect(resolved["VITE_WEB_URL"]).toBe(
            `https://${buildAppHostname("web", prNumber, repoFullName, domain, secret)}`,
        );
    });

    it("resolves {{name.url}} to the in-cluster connection string for a postgres service", () => {
        const configEnv = {
            DATABASE_URL: "{{db.url}}",
        };

        const resolved = injector.applyTemplates(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["DATABASE_URL"]).toBe("postgresql://preview:preview@db:5432/preview");
    });

    it("resolves {{name.url}} to the redis:// connection string for a redis service", () => {
        const configEnv = {
            REDIS_URL: "{{cache.url}}",
        };

        const resolved = injector.applyTemplates(
            configEnv,
            apps,
            services,
            "preview-ns",
            defaultContext,
            defaultPublicUrlInfo,
        );
        expect(resolved["REDIS_URL"]).toBe("redis://cache:6379");
    });

    it("throws when {{name.url}} is used on a service whose recipe defines no connection URL", () => {
        // Temporal speaks gRPC and has no single-scheme connection string, so
        // its recipe leaves `url` undefined - `{{temporal.url}}` must still throw.
        const temporalServices: ServiceConfig[] = [
            ...services,
            {
                name: "temporal",
                recipe: "temporal",
                env: {},
                resources: { cpu: "250m", memory: "512Mi" },
                options: undefined,
            },
        ];
        const configEnv = {
            FAIL: "{{temporal.url}}",
        };

        expect(() =>
            injector.applyTemplates(
                configEnv,
                apps,
                temporalServices,
                "preview-ns",
                defaultContext,
                defaultPublicUrlInfo,
            ),
        ).toThrow(/exposes no connection URL/);
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
        const { domain, repoFullName, prNumber, secret } = defaultPublicUrlInfo;
        expect(resolved["VITE_API_URL"]).toBe(
            `https://${buildAppHostname("api", prNumber, repoFullName, domain, secret)}`,
        );
        expect(resolved["BUILD_TARGET"]).toBe("pr-42");
        expect(resolved["STATIC"]).toBe("no-template-here");
    });
});
