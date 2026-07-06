import { describe, it, expect } from "vitest";
import type { AppConfig } from "../../src/config/schema";
import {
    buildAppDeployment,
    buildAppHostname,
    buildAppService,
    buildCentralGatekeeperRole,
    buildCentralGatekeeperRoleBinding,
    MANAGED_SELECTOR,
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

describe("MANAGED_SELECTOR", () => {
    it("matches the central Gatekeeper's TARGET_SELECTOR contract", () => {
        // BASE_LABELS is the source of truth for previewkit's workload label,
        // but two out-of-band artifacts hardcode the resulting selector string:
        // the central install's TARGET_SELECTOR (deployment/previewkit/cluster/
        // gatekeeper/gatekeeper.yaml) and the migration script's ingress sweep
        // (migrate-existing-previews.sh). This is the one assertion tying them
        // together - if the labels ever change, both must move in lockstep or
        // previews silently stop sleeping/waking.
        expect(MANAGED_SELECTOR).toBe("previewkit.dev/managed-by=previewkit");
    });
});

describe("central Gatekeeper per-namespace RBAC", () => {
    it("grants exactly the workload verbs the proxy needs, namespaced", () => {
        const role = buildCentralGatekeeperRole("preview-my-org-my-repo-pr-42", 42);
        expect(role.metadata?.namespace).toBe("preview-my-org-my-repo-pr-42");

        const appsRule = role.rules!.find((r) => r.apiGroups?.includes("apps"))!;
        expect(appsRule.resources).toEqual(expect.arrayContaining(["deployments", "statefulsets"]));
        expect(appsRule.verbs).toEqual(expect.arrayContaining(["get", "list", "watch", "patch"]));

        const podRule = role.rules!.find((r) => r.resources?.includes("pods"))!;
        expect(podRule.verbs).toEqual(["list"]);
    });

    it("binds to the central ServiceAccount in the gatekeeper namespace", () => {
        const rb = buildCentralGatekeeperRoleBinding("preview-my-org-my-repo-pr-42", "system", 42);
        expect(rb.roleRef.kind).toBe("Role");
        expect(rb.subjects).toEqual([{ kind: "ServiceAccount", name: "gatekeeper", namespace: "system" }]);
    });

    it("uses a name the legacy migration sweep will never delete", () => {
        // The migration script (migrate-existing-previews.sh) deletes the old
        // in-namespace Role/RoleBinding by their literal name "gatekeeper"; the
        // central grant must not share it or the sweep would revoke the very
        // RBAC it just stamped for that namespace.
        const role = buildCentralGatekeeperRole("ns", 1);
        const rb = buildCentralGatekeeperRoleBinding("ns", "system", 1);
        expect(role.metadata?.name).not.toBe("gatekeeper");
        expect(rb.metadata?.name).not.toBe("gatekeeper");
        expect(role.metadata?.name).toBe(rb.metadata?.name);
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

    it("drops user-set managed secret keys from config env so the mounted secret wins", () => {
        const dep = buildAppDeployment({
            ...baseOpts,
            resolvedEnv: {
                DATABASE_URL: "postgres://db:5432/preview",
                AUTONOMA_SHARED_SECRET: "user-supplied-value",
                AUTONOMA_SIGNING_SECRET: "user-supplied-value",
            },
        });
        const container = dep.spec!.template.spec!.containers[0]!;
        expect(container.env!.some((e) => e.name === "AUTONOMA_SHARED_SECRET")).toBe(false);
        expect(container.env!.some((e) => e.name === "AUTONOMA_SIGNING_SECRET")).toBe(false);
        expect(container.env!.some((e) => e.name === "DATABASE_URL")).toBe(true);
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
