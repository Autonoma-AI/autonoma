import { describe, it, expect } from "vitest";
import type { AppConfig } from "../../src/config/schema";
import { buildAppDeployment, buildAppService, buildNginxResources } from "../../src/deployer/resource-factory";

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
    it("creates a service targeting the correct port", () => {
        const svc = buildAppService(baseOpts);
        expect(svc.metadata?.name).toBe("web");
        expect(svc.spec!.ports![0]!.port).toBe(3000);
        expect(svc.spec!.selector!["app"]).toBe("web");
    });
});

describe("buildNginxResources", () => {
    const apiApp: AppConfig = {
        name: "api",
        path: "./apps/api",
        port: 4000,
        build_args: {},
        env: {},
        replicas: 1,
        resources: { cpu: "250m", memory: "256Mi" },
    };

    const nginxOpts = {
        apps: [baseApp, apiApp],
        namespace: "preview-acme-corp-my-repo-pr-42",
        owner: "acme-corp",
        prNumber: 42,
        domain: "preview.autonoma.app",
    };

    it("creates an nginx config with a server block per app", () => {
        const { configMap } = buildNginxResources(nginxOpts);
        const conf = configMap.data!["nginx.conf"]!;
        expect(conf).toContain("server_name web.pr-42.acme-corp.preview.autonoma.app;");
        expect(conf).toContain("server_name api.pr-42.acme-corp.preview.autonoma.app;");
        expect(conf).toContain("proxy_pass http://web:3000;");
        expect(conf).toContain("proxy_pass http://api:4000;");
    });

    it("creates a single ingress with a wildcard host", () => {
        const { ingress } = buildNginxResources(nginxOpts);
        expect(ingress.metadata?.name).toBe("nginx-router-ingress");
        const rule = ingress.spec!.rules![0]!;
        expect(rule.host).toBe("*.pr-42.acme-corp.preview.autonoma.app");
        expect(rule.http!.paths[0]!.backend!.service!.name).toBe("nginx-router");
        expect(rule.http!.paths[0]!.backend!.service!.port!.number).toBe(80);
    });

    it("creates an nginx deployment", () => {
        const { deployment } = buildNginxResources(nginxOpts);
        expect(deployment.metadata?.name).toBe("nginx-router");
        const container = deployment.spec!.template.spec!.containers[0]!;
        expect(container.image).toBe("nginx:1-alpine");
    });

    it("creates an nginx service on port 80", () => {
        const { service } = buildNginxResources(nginxOpts);
        expect(service.metadata?.name).toBe("nginx-router");
        expect(service.spec!.ports![0]!.port).toBe(80);
    });

    it("includes websocket upgrade headers in nginx config", () => {
        const { configMap } = buildNginxResources(nginxOpts);
        const conf = configMap.data!["nginx.conf"]!;
        expect(conf).toContain("proxy_set_header Upgrade $http_upgrade");
        expect(conf).toContain('proxy_set_header Connection "upgrade"');
    });

    it("includes a default 404 server", () => {
        const { configMap } = buildNginxResources(nginxOpts);
        const conf = configMap.data!["nginx.conf"]!;
        expect(conf).toContain("listen 80 default_server");
        expect(conf).toContain("return 404");
    });
});
