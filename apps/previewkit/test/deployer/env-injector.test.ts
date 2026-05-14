import { describe, it, expect } from "vitest";
import type { AppConfig, ServiceConfig } from "../../src/config/schema";
import { EnvInjector } from "../../src/deployer/env-injector";
import { RecipeRegistry } from "../../src/recipes/recipe-registry";

const registry = new RecipeRegistry();
const injector = new EnvInjector(registry);

const defaultContext = { pr: "42", namespace: "preview-acme-corp-my-repo-pr-42", owner: "acme-corp" };

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

        const resolved = injector.resolve(configEnv, {}, apps, services, "preview-ns", defaultContext);
        expect(resolved["DATABASE_URL"]).toBe("postgresql://preview:preview@db:5432/preview");
    });

    it("resolves app host and port templates", () => {
        const configEnv = {
            API_URL: "http://{{api.host}}:{{api.port}}",
        };

        const resolved = injector.resolve(configEnv, {}, apps, services, "preview-ns", defaultContext);
        expect(resolved["API_URL"]).toBe("http://api:4000");
    });

    it("resolves redis templates", () => {
        const configEnv = {
            REDIS_URL: "redis://{{cache.host}}:{{cache.port}}",
        };

        const resolved = injector.resolve(configEnv, {}, apps, services, "preview-ns", defaultContext);
        expect(resolved["REDIS_URL"]).toBe("redis://cache:6379");
    });

    it("passes through non-template values unchanged", () => {
        const configEnv = {
            NODE_ENV: "production",
            LOG_LEVEL: "info",
        };

        const resolved = injector.resolve(configEnv, {}, apps, services, "preview-ns", defaultContext);
        expect(resolved).toEqual(configEnv);
    });

    it("handles multiple templates in one value", () => {
        const configEnv = {
            CONFIG: "{{db.host}}:{{db.port}},{{cache.host}}:{{cache.port}}",
        };

        const resolved = injector.resolve(configEnv, {}, apps, services, "preview-ns", defaultContext);
        expect(resolved["CONFIG"]).toBe("db:5432,cache:6379");
    });

    it("throws on unknown service reference", () => {
        const configEnv = {
            URL: "http://{{unknown.host}}:{{unknown.port}}",
        };

        expect(() => injector.resolve(configEnv, {}, apps, services, "preview-ns", defaultContext)).toThrow(
            /Unknown service\/app reference/,
        );
    });

    it("includes stored secrets in resolved env", () => {
        const storedSecrets = {
            OPENAI_API_KEY: "sk-test-123",
            STRIPE_KEY: "sk_test_456",
        };

        const resolved = injector.resolve({}, storedSecrets, apps, services, "preview-ns", defaultContext);
        expect(resolved["OPENAI_API_KEY"]).toBe("sk-test-123");
        expect(resolved["STRIPE_KEY"]).toBe("sk_test_456");
    });

    it(".preview.yaml env overrides stored secrets", () => {
        const storedSecrets = {
            DATABASE_URL: "postgres://production:5432/prod",
            OPENAI_API_KEY: "sk-test-123",
        };
        const configEnv = {
            DATABASE_URL: "postgresql://preview:preview@{{db.host}}:{{db.port}}/preview",
        };

        const resolved = injector.resolve(configEnv, storedSecrets, apps, services, "preview-ns", defaultContext);
        expect(resolved["DATABASE_URL"]).toBe("postgresql://preview:preview@db:5432/preview");
        expect(resolved["OPENAI_API_KEY"]).toBe("sk-test-123");
    });

    it("stored secrets with no config env pass through as-is", () => {
        const storedSecrets = {
            API_KEY: "some-key",
            NODE_ENV: "preview",
        };

        const resolved = injector.resolve({}, storedSecrets, apps, services, "preview-ns", defaultContext);
        expect(resolved["API_KEY"]).toBe("some-key");
        expect(resolved["NODE_ENV"]).toBe("preview");
    });

    it("resolves {{pr}} template", () => {
        const configEnv = {
            TASK_QUEUE: "pr-{{pr}}-default",
        };

        const resolved = injector.resolve(configEnv, {}, apps, services, "preview-ns", defaultContext);
        expect(resolved["TASK_QUEUE"]).toBe("pr-42-default");
    });

    it("resolves {{namespace}} template", () => {
        const configEnv = {
            K8S_NAMESPACE: "{{namespace}}",
        };

        const resolved = injector.resolve(configEnv, {}, apps, services, "preview-ns", defaultContext);
        expect(resolved["K8S_NAMESPACE"]).toBe("preview-acme-corp-my-repo-pr-42");
    });

    it("resolves {{owner}} template", () => {
        const configEnv = {
            ORG: "{{owner}}",
        };

        const resolved = injector.resolve(configEnv, {}, apps, services, "preview-ns", defaultContext);
        expect(resolved["ORG"]).toBe("acme-corp");
    });

    it("resolves Temporal service with context variables", () => {
        const temporalServices: ServiceConfig[] = [
            ...services,
            {
                name: "temporal",
                recipe: "temporal",
                env: { address: "temporal.shared.svc.cluster.local:7233" },
                resources: { cpu: "250m", memory: "256Mi" },
            },
        ];

        const configEnv = {
            TEMPORAL_ADDRESS: "{{temporal.host}}:{{temporal.port}}",
            TEMPORAL_NAMESPACE: "preview-pr-{{pr}}",
            TEMPORAL_TASK_QUEUE: "pr-{{pr}}-default",
        };

        const resolved = injector.resolve(configEnv, {}, apps, temporalServices, "preview-ns", defaultContext);
        expect(resolved["TEMPORAL_ADDRESS"]).toBe("temporal.shared.svc.cluster.local:7233");
        expect(resolved["TEMPORAL_NAMESPACE"]).toBe("preview-pr-42");
        expect(resolved["TEMPORAL_TASK_QUEUE"]).toBe("pr-42-default");
    });

    it("mixes context variables with service templates in one value", () => {
        const configEnv = {
            WORKER_ID: "{{owner}}-pr-{{pr}}-{{api.host}}",
        };

        const resolved = injector.resolve(configEnv, {}, apps, services, "preview-ns", defaultContext);
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

        const resolved = injector.resolve(configEnv, {}, apps, hyphenatedServices, "preview-ns", defaultContext);
        expect(resolved["GATEWAY_URL"]).toBe("http://api-gateway:80");
    });

    it("resolves templates inside stored-secret values, not just config env", () => {
        const storedSecrets = {
            DATABASE_URL: "postgresql://preview:preview@{{db.host}}:{{db.port}}/preview",
        };

        const resolved = injector.resolve({}, storedSecrets, apps, services, "preview-ns", defaultContext);
        expect(resolved["DATABASE_URL"]).toBe("postgresql://preview:preview@db:5432/preview");
    });

    it("returns an empty object when there is no env and no stored secrets", () => {
        const resolved = injector.resolve({}, {}, apps, services, "preview-ns", defaultContext);
        expect(resolved).toEqual({});
    });

    it("passes through values that look templated but do not match the grammar", () => {
        // `{{api.foo}}` — wrong field. `{{ pr }}` — internal whitespace.
        // `{{api}}`    — missing .host/.port. None of these should resolve;
        //               all should pass through verbatim.
        const configEnv = {
            LITERAL_BRACES: "use {{api.foo}} or {{ pr }} or {{api}} as-is",
        };

        const resolved = injector.resolve(configEnv, {}, apps, services, "preview-ns", defaultContext);
        expect(resolved["LITERAL_BRACES"]).toBe("use {{api.foo}} or {{ pr }} or {{api}} as-is");
    });
});
