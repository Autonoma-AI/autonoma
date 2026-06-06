import { describe, it, expect } from "vitest";
import type { AppConfig } from "../../src/config/schema";
import {
    buildAppDeployment,
    buildAppHostname,
    buildAppIngress,
    buildAppService,
    buildNginxConfig,
    NGINX_SERVICE_NAME,
    NGINX_SERVICE_PORT,
} from "../../src/deployer/resource-factory";

const baseApp: AppConfig = {
    name: "web",
    path: "./apps/web",
    port: 3000,
    build_args: {},
    build_secrets: [],
    env: {},
    replicas: 1,
    resources: { cpu: "1000m", memory: "1Gi" },
};

const baseOpts = {
    app: baseApp,
    namespace: "preview-my-org-my-repo-pr-42",
    imageTag: "ghcr.io/my-org/web:pr-42-abc1234",
    resolvedEnv: { DATABASE_URL: "postgres://db:5432/preview" },
    prNumber: 42,
};

const baseRouteOpts = {
    app: baseApp,
    namespace: "preview-my-org-my-repo-pr-42",
    prNumber: 42,
    repoFullName: "my-org/my-repo",
    domain: "preview.autonoma.app",
    secret: "test-secret",
    ingressClassName: "nginx",
};

describe("buildNginxConfig", () => {
    const apps = [
        { name: "web", port: 3000, hostname: "web.preview.autonoma.app" },
        { name: "api", port: 4000, hostname: "api.preview.autonoma.app" },
    ];
    const namespace = "preview-my-org-my-repo-pr-42";

    it("proxies every app straight through to its in-cluster service", () => {
        const conf = buildNginxConfig({ apps, namespace });
        expect(conf).toContain(`proxy_pass http://web.${namespace}.svc.cluster.local:3000;`);
        expect(conf).toContain(`proxy_pass http://api.${namespace}.svc.cluster.local:4000;`);
    });

    it("has no access gate - previews are intentionally public", () => {
        const conf = buildNginxConfig({ apps, namespace });
        // None of the auth-gate machinery should be emitted: no bypass-token /
        // pk_session check, no auth page, no redirect away from the app.
        expect(conf).not.toContain("$is_auth");
        expect(conf).not.toContain("pk_session");
        expect(conf).not.toContain("preview-auth");
        expect(conf).not.toContain("return 302");
    });
});

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

describe("buildAppIngress", () => {
    it("creates an nginx-class Ingress in the preview namespace", () => {
        const ing = buildAppIngress(baseRouteOpts);
        expect(ing.apiVersion).toBe("networking.k8s.io/v1");
        expect(ing.kind).toBe("Ingress");
        expect(ing.metadata?.name).toBe("web");
        expect(ing.metadata?.namespace).toBe("preview-my-org-my-repo-pr-42");
        expect(ing.spec?.ingressClassName).toBe("nginx");
    });

    it("declares no TLS block — the ALB terminates TLS upstream", () => {
        const ing = buildAppIngress(baseRouteOpts);
        expect(ing.spec?.tls).toBeUndefined();
    });

    it("routes the masked single-label host to the shared nginx Service", () => {
        const ing = buildAppIngress(baseRouteOpts);
        const rule = ing.spec!.rules![0]!;
        expect(rule.host).toBe(buildAppHostname("web", 42, "my-org/my-repo", "preview.autonoma.app", "test-secret"));

        const path = rule.http!.paths[0]!;
        expect(path.path).toBe("/");
        expect(path.pathType).toBe("Prefix");
        expect(path.backend.service!.name).toBe(NGINX_SERVICE_NAME);
        expect(path.backend.service!.port!.number).toBe(NGINX_SERVICE_PORT);
    });

    it("does not leak the service or repo name into the routed host", () => {
        const ing = buildAppIngress(baseRouteOpts);
        const subdomain = ing.spec!.rules![0]!.host!.split(".")[0]!;
        expect(subdomain).not.toContain("web");
        expect(subdomain).not.toContain("my-org");
    });
});
