import { describe, it, expect } from "vitest";
import type { AppConfig } from "../../src/config/schema";
import {
    buildAppDeployment,
    buildAppHostname,
    buildAppHttpRoute,
    buildAppService,
    buildAppTargetGroupConfig,
    type GatewayRef,
} from "../../src/deployer/resource-factory";

const baseApp: AppConfig = {
    name: "web",
    path: "./apps/web",
    port: 3000,
    build_args: {},
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
    repoSlug: "my-org-my-repo",
    domain: "preview.autonoma.app",
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
        expect(container.env).toEqual([{ name: "DATABASE_URL", value: "postgres://db:5432/preview" }]);
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
    it("flattens to a single leftmost label so a wildcard ACM cert matches", () => {
        const host = buildAppHostname("web", 42, "my-org-my-repo", "preview.autonoma.app");
        expect(host).toBe("web-pr-42-my-org-my-repo.preview.autonoma.app");
        expect(host.split(".")[0]).not.toContain(".");
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

    it("uses the flattened single-label hostname", () => {
        const route = buildAppHttpRoute(baseRouteOpts);
        expect(route.spec.hostnames).toEqual(["web-pr-42-my-org-my-repo.preview.autonoma.app"]);
    });

    it("routes / to the app Service on its configured port", () => {
        const route = buildAppHttpRoute(baseRouteOpts);
        const rule = route.spec.rules[0]!;
        expect(rule.matches[0]!.path).toEqual({ type: "PathPrefix", value: "/" });
        const backend = rule.backendRefs[0]!;
        expect(backend.kind).toBe("Service");
        expect(backend.name).toBe("web");
        expect(backend.port).toBe(3000);
    });
});

describe("buildAppTargetGroupConfig", () => {
    it("pins targetType to ip so the ALB hits pods directly", () => {
        const tgc = buildAppTargetGroupConfig(baseRouteOpts);
        expect(tgc.apiVersion).toBe("gateway.k8s.aws/v1beta1");
        expect(tgc.kind).toBe("TargetGroupConfiguration");
        expect(tgc.spec.defaultConfiguration.targetType).toBe("ip");
    });

    it("references the app's Service by name", () => {
        const tgc = buildAppTargetGroupConfig(baseRouteOpts);
        expect(tgc.spec.targetReference.kind).toBe("Service");
        expect(tgc.spec.targetReference.name).toBe("web");
    });

    it("includes health check config when the app declares one", () => {
        const tgc = buildAppTargetGroupConfig({
            ...baseRouteOpts,
            app: { ...baseApp, health_check: "/health" },
        });
        expect(tgc.spec.defaultConfiguration.healthCheckConfig).toEqual({
            healthCheckPath: "/health",
            healthCheckProtocol: "HTTP",
        });
    });

    it("omits health check config when the app declares none", () => {
        const tgc = buildAppTargetGroupConfig(baseRouteOpts);
        expect(tgc.spec.defaultConfiguration.healthCheckConfig).toBeUndefined();
    });
});
