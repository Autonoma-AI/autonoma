import { describe, it, expect } from "vitest";
import type { AppConfig } from "../../src/config/schema";
import {
    buildAppDeployment,
    buildAppHostname,
    buildAppHttpRoute,
    buildAppService,
    buildAppTargetGroupConfig,
    NGINX_HEALTH_PATH,
    NGINX_SERVICE_NAME,
    NGINX_SERVICE_PORT,
    type GatewayRef,
} from "../../src/deployer/resource-factory";

const baseApp: AppConfig = {
    name: "web",
    path: "./apps/web",
    port: 3000,
    build_args: {},
    build_secrets: [],
    env: {},
    replicas: 1,
    resources: { cpu: "250m", memory: "256Mi" },
};

const baseOpts = {
    app: baseApp,
    namespace: "preview-my-org-my-repo-pr-42",
    imageTag: "ghcr.io/my-org/web:pr-42-abc1234",
    resolvedEnv: { DATABASE_URL: "postgres://db:5432/preview" },
    prNumber: 42,
};

const gateway: GatewayRef = {
    name: "preview-gateway",
    namespace: "gateway-system",
    listener: "https",
};

const baseRouteOpts = {
    app: baseApp,
    namespace: "preview-my-org-my-repo-pr-42",
    prNumber: 42,
    repoFullName: "my-org/my-repo",
    domain: "preview.autonoma.app",
    secret: "test-secret",
    gateway,
};

describe("buildAppDeployment", () => {
    it("creates a deployment with correct metadata", () => {
        const dep = buildAppDeployment(baseOpts);
        expect(dep.metadata?.name).toBe("web");
        expect(dep.metadata?.namespace).toBe("preview-my-org-my-repo-pr-42");
        expect(dep.metadata?.labels?.["previewkit.dev/managed-by"]).toBe("previewkit");
    });

    it("sets the correct image and port", () => {
        const dep = buildAppDeployment(baseOpts);
        const container = dep.spec!.template.spec!.containers[0]!;
        expect(container.image).toBe("ghcr.io/my-org/web:pr-42-abc1234");
        expect(container.ports![0]!.containerPort).toBe(3000);
    });

    it("injects resolved environment variables", () => {
        const dep = buildAppDeployment(baseOpts);
        const container = dep.spec!.template.spec!.containers[0]!;
        expect(container.env).toEqual([
            { name: "DATABASE_URL", value: "postgres://db:5432/preview" },
            { name: "PORT", value: "3000" },
        ]);
    });

    it("sets replicas from config", () => {
        const dep = buildAppDeployment({ ...baseOpts, app: { ...baseApp, replicas: 3 } });
        expect(dep.spec!.replicas).toBe(3);
    });

    it("sets command when provided", () => {
        const dep = buildAppDeployment({ ...baseOpts, app: { ...baseApp, command: "npm run worker" } });
        const container = dep.spec!.template.spec!.containers[0]!;
        expect(container.command).toEqual(["/bin/sh", "-c", "npm run worker"]);
    });

    it("sets health check probes when provided", () => {
        const dep = buildAppDeployment({ ...baseOpts, app: { ...baseApp, health_check: "/health" } });
        const container = dep.spec!.template.spec!.containers[0]!;
        expect(container.readinessProbe?.httpGet?.path).toBe("/health");
        expect(container.livenessProbe?.httpGet?.path).toBe("/health");
    });

    it("omits probes when no health check", () => {
        const dep = buildAppDeployment(baseOpts);
        const container = dep.spec!.template.spec!.containers[0]!;
        expect(container.readinessProbe).toBeUndefined();
        expect(container.livenessProbe).toBeUndefined();
    });
});

describe("buildAppService", () => {
    it("creates a ClusterIP service targeting the correct port", () => {
        const svc = buildAppService(baseOpts);
        expect(svc.metadata?.name).toBe("web");
        expect(svc.spec!.type).toBe("ClusterIP");
        expect(svc.spec!.ports![0]!.port).toBe(3000);
        expect(svc.spec!.selector!["app"]).toBe("web");
    });
});

describe("buildAppHostname", () => {
    it("produces a single-label hex hostname so a wildcard ACM cert matches", () => {
        const host = buildAppHostname("web", 42, "my-org/my-repo", "preview.autonoma.app", "test-secret");
        expect(host).toMatch(/^[0-9a-f]{12}\.preview\.autonoma\.app$/);
    });

    it("is deterministic — same inputs always return the same hostname", () => {
        const a = buildAppHostname("web", 42, "my-org/my-repo", "preview.autonoma.app", "test-secret");
        const b = buildAppHostname("web", 42, "my-org/my-repo", "preview.autonoma.app", "test-secret");
        expect(a).toBe(b);
    });

    it("produces different hostnames for different inputs", () => {
        const webHost = buildAppHostname("web", 42, "my-org/my-repo", "preview.autonoma.app", "test-secret");
        const apiHost = buildAppHostname("api", 42, "my-org/my-repo", "preview.autonoma.app", "test-secret");
        const pr2Host = buildAppHostname("web", 2, "my-org/my-repo", "preview.autonoma.app", "test-secret");
        expect(webHost).not.toBe(apiHost);
        expect(webHost).not.toBe(pr2Host);
    });

    it("produces different hostnames for different secrets", () => {
        const a = buildAppHostname("web", 42, "my-org/my-repo", "preview.autonoma.app", "secret-a");
        const b = buildAppHostname("web", 42, "my-org/my-repo", "preview.autonoma.app", "secret-b");
        expect(a).not.toBe(b);
    });

    it("does not expose service name or repo name in the subdomain", () => {
        const host = buildAppHostname("web", 42, "my-org/my-repo", "preview.autonoma.app", "test-secret");
        const subdomain = host.split(".")[0]!;
        expect(subdomain).not.toContain("web");
        expect(subdomain).not.toContain("my-org");
    });
});

describe("buildAppHttpRoute", () => {
    it("attaches to the shared Gateway's HTTPS listener", () => {
        const route = buildAppHttpRoute(baseRouteOpts);
        expect(route.apiVersion).toBe("gateway.networking.k8s.io/v1");
        expect(route.kind).toBe("HTTPRoute");
        expect(route.metadata.name).toBe("web");
        expect(route.metadata.namespace).toBe("preview-my-org-my-repo-pr-42");

        const parent = route.spec.parentRefs[0]!;
        expect(parent.name).toBe("preview-gateway");
        expect(parent.namespace).toBe("gateway-system");
        expect(parent.sectionName).toBe("https");
        expect(parent.kind).toBe("Gateway");
    });

    it("uses the masked single-label hostname from buildAppHostname", () => {
        const route = buildAppHttpRoute(baseRouteOpts);
        expect(route.spec.hostnames).toEqual([
            buildAppHostname("web", 42, "my-org/my-repo", "preview.autonoma.app", "test-secret"),
        ]);
    });

    it("routes / to the shared nginx Service", () => {
        const route = buildAppHttpRoute(baseRouteOpts);
        const rule = route.spec.rules[0]!;
        expect(rule.matches[0]!.path).toEqual({ type: "PathPrefix", value: "/" });
        const backend = rule.backendRefs[0]!;
        expect(backend.kind).toBe("Service");
        expect(backend.name).toBe(NGINX_SERVICE_NAME);
        expect(backend.port).toBe(NGINX_SERVICE_PORT);
    });
});

describe("buildAppTargetGroupConfig", () => {
    it("pins targetType to ip so the ALB hits pods directly", () => {
        const tgc = buildAppTargetGroupConfig(baseRouteOpts);
        expect(tgc.apiVersion).toBe("gateway.k8s.aws/v1beta1");
        expect(tgc.kind).toBe("TargetGroupConfiguration");
        expect(tgc.spec.defaultConfiguration.targetType).toBe("ip");
    });

    it("references the shared nginx Service by name", () => {
        const tgc = buildAppTargetGroupConfig(baseRouteOpts);
        expect(tgc.spec.targetReference.kind).toBe("Service");
        expect(tgc.spec.targetReference.name).toBe(NGINX_SERVICE_NAME);
    });

    it("uses the nginx health check even when the app declares one", () => {
        const tgc = buildAppTargetGroupConfig({
            ...baseRouteOpts,
            app: { ...baseApp, health_check: "/health" },
        });
        expect(tgc.spec.defaultConfiguration.healthCheckConfig).toEqual({
            healthCheckPath: NGINX_HEALTH_PATH,
            healthCheckProtocol: "HTTP",
        });
    });

    it("uses the nginx health check when the app declares none", () => {
        const tgc = buildAppTargetGroupConfig(baseRouteOpts);
        expect(tgc.spec.defaultConfiguration.healthCheckConfig).toEqual({
            healthCheckPath: NGINX_HEALTH_PATH,
            healthCheckProtocol: "HTTP",
        });
    });
});
