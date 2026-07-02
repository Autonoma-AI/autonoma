import { describe, it, expect } from "vitest";
import type { AppConfig } from "../../src/config/schema";
import {
    buildAppDeployment,
    buildAppHostname,
    buildAppIngress,
    buildAppService,
    buildGatekeeperConfigMap,
    buildGatekeeperDeployment,
    buildGatekeeperRole,
    buildGatekeeperRoleBinding,
    buildGatekeeperServiceAccount,
    GATEKEEPER_APP_LABEL,
    GATEKEEPER_CONTAINER_PORT,
    GATEKEEPER_SERVICE_NAME,
    GATEKEEPER_SERVICE_PORT,
} from "../../src/deployer/resource-factory";

const baseApp: AppConfig = {
    name: "web",
    path: "./apps/web",
    port: 3000,
    build_args: {},
    build_secrets: [],
    env: {},
    replicas: 1,
    resources: { cpu: "250m", memoryRequest: "512Mi", memoryLimit: "1Gi" },
};

const baseOpts = {
    app: baseApp,
    namespace: "preview-my-org-my-repo-pr-42",
    imageTag: "ghcr.io/my-org/web:pr-42-abc1234",
    resolvedEnv: { DATABASE_URL: "postgres://db:5432/preview" },
    prNumber: 42,
    publicUrl: "https://abc123def456.preview.autonoma.app",
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

const gatekeeperOpts = {
    apps: [
        { name: "web", port: 3000, hostname: "web.preview.autonoma.app" },
        { name: "api", port: 4000, hostname: "api.preview.autonoma.app" },
    ],
    namespace: "preview-my-org-my-repo-pr-42",
    prNumber: 42,
    bypassToken: "deadbeefcafe",
    cookieDomain: "preview.autonoma.app",
    appUrl: "https://app.autonoma.app",
    image: "public.ecr.aws/autonoma/gatekeeper:latest",
    idleTimeout: "45m",
};

describe("buildGatekeeperConfigMap", () => {
    it("builds a host -> {service, port} routing table as routes.json", () => {
        const cm = buildGatekeeperConfigMap({
            apps: gatekeeperOpts.apps,
            namespace: gatekeeperOpts.namespace,
            prNumber: 42,
        });
        const routes = JSON.parse(cm.data!["routes.json"]!);
        expect(routes["web.preview.autonoma.app"]).toEqual({ service: "web", port: 3000 });
        expect(routes["api.preview.autonoma.app"]).toEqual({ service: "api", port: 4000 });
    });
});

describe("buildGatekeeperDeployment", () => {
    it("runs as the gatekeeper service account and self-excludes via the app label", () => {
        const dep = buildGatekeeperDeployment(gatekeeperOpts);
        expect(dep.spec!.template.spec!.serviceAccountName).toBe("gatekeeper");
        expect(dep.metadata?.labels?.["app"]).toBe(GATEKEEPER_APP_LABEL);
        // It carries managed-by like every workload, so the scaler must exclude it by app label.
        expect(dep.metadata?.labels?.["previewkit.dev/managed-by"]).toBe("previewkit");
    });

    it("listens on the container port and injects config via env", () => {
        const dep = buildGatekeeperDeployment(gatekeeperOpts);
        const c = dep.spec!.template.spec!.containers[0]!;
        expect(c.image).toBe("public.ecr.aws/autonoma/gatekeeper:latest");
        expect(c.ports![0]!.containerPort).toBe(GATEKEEPER_CONTAINER_PORT);

        const env = c.env ?? [];
        const get = (name: string) => env.find((e) => e.name === name);
        expect(get("TARGET_SELECTOR")?.value).toBe("previewkit.dev/managed-by=previewkit");
        expect(get("SELF_NAME")?.value).toBe("gatekeeper");
        expect(get("HEALTH_PATH")?.value).toBe("/gatekeeper-health");
        expect(get("IDLE_TIMEOUT")?.value).toBe("45m");
        expect(get("NAMESPACE")?.valueFrom?.fieldRef?.fieldPath).toBe("metadata.namespace");
        expect(get("ROUTES_JSON")?.valueFrom?.configMapKeyRef?.key).toBe("routes.json");
    });

    it("targets the dedicated gatekeeper NodePool by label and tolerates its taint", () => {
        const dep = buildGatekeeperDeployment(gatekeeperOpts);
        const podSpec = dep.spec!.template.spec!;
        expect(podSpec.nodeSelector?.["pool"]).toBe("gatekeeper");
        expect(podSpec.tolerations).toContainEqual({
            key: "pool",
            operator: "Equal",
            value: "gatekeeper",
            effect: "NoSchedule",
        });
    });
});

describe("buildGatekeeperServiceAccount", () => {
    it("creates the gatekeeper service account in the namespace", () => {
        const sa = buildGatekeeperServiceAccount("preview-my-org-my-repo-pr-42", 42);
        expect(sa.metadata?.name).toBe("gatekeeper");
        expect(sa.metadata?.namespace).toBe("preview-my-org-my-repo-pr-42");
    });
});

describe("buildGatekeeperRole", () => {
    it("grants patch on workloads and read on pods to scale + detect readiness", () => {
        const role = buildGatekeeperRole("preview-my-org-my-repo-pr-42", 42);
        const appsRule = role.rules!.find((r) => r.apiGroups?.includes("apps"))!;
        expect(appsRule.resources).toEqual(expect.arrayContaining(["deployments", "statefulsets"]));
        expect(appsRule.verbs).toEqual(expect.arrayContaining(["get", "list", "watch", "patch"]));

        const podRule = role.rules!.find((r) => r.resources?.includes("pods"))!;
        expect(podRule.apiGroups).toContain("");
        expect(podRule.verbs).toContain("list");
    });
});

describe("buildGatekeeperRoleBinding", () => {
    it("binds the gatekeeper Role to the gatekeeper ServiceAccount", () => {
        const rb = buildGatekeeperRoleBinding("preview-my-org-my-repo-pr-42", 42);
        expect(rb.roleRef.kind).toBe("Role");
        expect(rb.roleRef.name).toBe("gatekeeper");
        expect(rb.subjects![0]!.kind).toBe("ServiceAccount");
        expect(rb.subjects![0]!.name).toBe("gatekeeper");
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

    it("mounts the app's secret via envFrom and rolls pods on a secret-version change", () => {
        const v1 = buildAppDeployment({ ...baseOpts, awsSecretName: "web-secrets", secretVersion: "12345" });
        const container = v1.spec!.template.spec!.containers[0]!;
        expect(container.envFrom).toEqual([{ secretRef: { name: "web-secrets" } }]);
        // The pod template carries the secret version, so a changed version
        // produces a different template and forces a rollout onto the new secret.
        expect(v1.spec!.template.metadata?.annotations?.["previewkit.dev/secret-version"]).toBe("12345");

        const v2 = buildAppDeployment({ ...baseOpts, awsSecretName: "web-secrets", secretVersion: "67890" });
        expect(v2.spec!.template.metadata?.annotations?.["previewkit.dev/secret-version"]).toBe("67890");
    });

    it("omits the secret-version annotation when the app has no secret", () => {
        const dep = buildAppDeployment(baseOpts);
        const container = dep.spec!.template.spec!.containers[0]!;
        expect(container.envFrom).toBeUndefined();
        expect(dep.spec!.template.metadata?.annotations?.["previewkit.dev/secret-version"]).toBeUndefined();
    });

    it("requests cpu and memory separately from the memory limit, with no cpu limit", () => {
        const dep = buildAppDeployment(baseOpts);
        const container = dep.spec!.template.spec!.containers[0]!;
        expect(container.resources).toEqual({
            requests: { cpu: "250m", memory: "512Mi" },
            limits: { memory: "1Gi" },
        });
    });

    it("injects resolved environment variables plus the built-ins", () => {
        const dep = buildAppDeployment(baseOpts);
        const container = dep.spec!.template.spec!.containers[0]!;
        expect(container.env).toEqual([
            { name: "DATABASE_URL", value: "postgres://db:5432/preview" },
            { name: "PORT", value: "3000" },
            { name: "AUTONOMA_PREVIEWKIT", value: "true" },
            { name: "AUTONOMA_PREVIEWKIT_PR", value: "42" },
            { name: "AUTONOMA_PREVIEWKIT_URL", value: "https://abc123def456.preview.autonoma.app" },
        ]);
    });

    it("overrides any user-set built-in keys with the canonical injected values", () => {
        const dep = buildAppDeployment({
            ...baseOpts,
            resolvedEnv: {
                DATABASE_URL: "postgres://db:5432/preview",
                AUTONOMA_PREVIEWKIT_URL: "https://attacker.example.com",
                AUTONOMA_PREVIEWKIT: "false",
            },
        });
        const container = dep.spec!.template.spec!.containers[0]!;
        const builtins = container.env!.filter((e) => e.name.startsWith("AUTONOMA_PREVIEWKIT"));
        // Exactly one of each, with the real values - no duplicate env entries.
        expect(builtins).toEqual([
            { name: "AUTONOMA_PREVIEWKIT", value: "true" },
            { name: "AUTONOMA_PREVIEWKIT_PR", value: "42" },
            { name: "AUTONOMA_PREVIEWKIT_URL", value: "https://abc123def456.preview.autonoma.app" },
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

    it("stamps the depends-on annotation from app.depends_on", () => {
        const dep = buildAppDeployment({ ...baseOpts, app: { ...baseApp, depends_on: ["db", "cache"] } });
        expect(dep.metadata?.annotations?.["gatekeeper.dev/depends-on"]).toBe("db,cache");
    });

    it("omits the depends-on annotation when there are no dependencies", () => {
        const dep = buildAppDeployment(baseOpts);
        expect(dep.metadata?.annotations?.["gatekeeper.dev/depends-on"]).toBeUndefined();
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

    it("routes the masked single-label host to the Gatekeeper Service", () => {
        const ing = buildAppIngress(baseRouteOpts);
        const rule = ing.spec!.rules![0]!;
        expect(rule.host).toBe(buildAppHostname("web", 42, "my-org/my-repo", "preview.autonoma.app", "test-secret"));

        const path = rule.http!.paths[0]!;
        expect(path.path).toBe("/");
        expect(path.pathType).toBe("Prefix");
        expect(path.backend.service!.name).toBe(GATEKEEPER_SERVICE_NAME);
        expect(path.backend.service!.port!.number).toBe(GATEKEEPER_SERVICE_PORT);
    });

    it("does not leak the service or repo name into the routed host", () => {
        const ing = buildAppIngress(baseRouteOpts);
        const subdomain = ing.spec!.rules![0]!.host!.split(".")[0]!;
        expect(subdomain).not.toContain("web");
        expect(subdomain).not.toContain("my-org");
    });
});
