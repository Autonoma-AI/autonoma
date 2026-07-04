import type { PreviewDeployEvent } from "@autonoma/types";
import type { V1Job } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
    type ConfigMapReader,
    PreviewkitJobLauncher,
    type PreviewJobsApi,
    previewEnvKey,
} from "../../src/previewkit/previewkit-job-launcher";

// The Job is created in the shared previewkit namespace; the runner-image
// ConfigMap is read from the API's own (per-env) namespace.
const JOB_NAMESPACE = "previewkit";
const IMAGE_NAMESPACE = "beta";
const RUNNER_IMAGE = "registry/beta/previewkit:abc123def";
const DATABASE_URL = "postgresql://user:pass@beta-db:5432/beta";
const SENTRY_ENV = "beta";

const event: PreviewDeployEvent = {
    action: "synchronize",
    prNumber: 42,
    repoFullName: "acme/widgets",
    organizationId: "org_1",
    githubRepositoryId: 99,
    headSha: "abc123def4567890",
    headRef: "feature/x",
    baseSha: "base000",
    baseRef: "main",
    cloneUrl: "https://github.com/acme/widgets.git",
};

/** Records every Batch API call and returns whatever jobs the test seeds. */
class FakeJobsApi implements PreviewJobsApi {
    existingJobs: V1Job[] = [];
    readonly listCalls: Array<{ namespace: string; labelSelector?: string }> = [];
    readonly deleteCalls: Array<{ name: string; namespace: string; propagationPolicy?: string }> = [];
    readonly createdJobs: V1Job[] = [];
    readonly createNamespaces: string[] = [];

    async listNamespacedJob(params: { namespace: string; labelSelector?: string }): Promise<{ items: V1Job[] }> {
        this.listCalls.push(params);
        return { items: this.existingJobs };
    }
    async createNamespacedJob(params: { namespace: string; body: V1Job }): Promise<V1Job> {
        this.createNamespaces.push(params.namespace);
        this.createdJobs.push(params.body);
        return params.body;
    }
    async deleteNamespacedJob(params: {
        name: string;
        namespace: string;
        propagationPolicy?: string;
    }): Promise<unknown> {
        this.deleteCalls.push(params);
        return {};
    }
}

/** Returns the runner-image ConfigMap; `image` undefined simulates a missing key. */
class FakeConfigMaps implements ConfigMapReader {
    readonly readNamespaces: string[] = [];
    constructor(private readonly image: string | undefined) {}
    async readNamespacedConfigMap(params: {
        name: string;
        namespace: string;
    }): Promise<{ data?: Record<string, string> }> {
        this.readNamespaces.push(params.namespace);
        return { data: this.image != null ? { image: this.image } : {} };
    }
}

function launcher(api: FakeJobsApi, cms: ConfigMapReader = new FakeConfigMaps(RUNNER_IMAGE)): PreviewkitJobLauncher {
    return new PreviewkitJobLauncher({
        batchApi: api,
        coreApi: cms,
        jobNamespace: JOB_NAMESPACE,
        imageNamespace: IMAGE_NAMESPACE,
        databaseUrl: DATABASE_URL,
        sentryEnv: SENTRY_ENV,
    });
}

function container(job: V1Job) {
    const c = job.spec?.template.spec?.containers[0];
    if (c == null) throw new Error("job has no container");
    return c;
}

function jobSpecEnv(job: V1Job): {
    mode: string;
    event: PreviewDeployEvent;
    configRevisionId?: string;
    namespace?: string;
    appName?: string;
    redeployMode?: string;
} {
    const value = container(job).env?.find((e) => e.name === "PREVIEWKIT_JOB_SPEC")?.value;
    if (value == null) throw new Error("job has no PREVIEWKIT_JOB_SPEC env");
    return JSON.parse(value);
}

describe("PreviewkitJobLauncher.launchDeploy", () => {
    it("creates a deploy job with the ConfigMap-pinned image and env mutex label", async () => {
        const api = new FakeJobsApi();
        await launcher(api).launchDeploy({ event });

        expect(api.deleteCalls).toHaveLength(0);
        expect(api.createdJobs).toHaveLength(1);

        const job = api.createdJobs[0];
        if (job == null) throw new Error("no job created");
        const envKey = previewEnvKey(event.repoFullName, event.prNumber);

        expect(job.metadata?.generateName).toMatch(/^pk-deploy-acme-widgets-42-$/);
        expect(job.metadata?.labels?.["previewkit.dev/env"]).toBe(envKey);
        expect(job.metadata?.labels?.["previewkit.dev/type"]).toBe("deploy");
        expect(job.metadata?.annotations?.["previewkit.dev/repo"]).toBe("acme/widgets");
        expect(job.spec?.backoffLimit).toBe(1);
        expect(job.spec?.template.spec?.restartPolicy).toBe("Never");
        expect(job.spec?.template.spec?.serviceAccountName).toBe("previewkit");

        const c = container(job);
        // SHA-pinned image resolved from the previewkit-runner-image ConfigMap.
        expect(c.image).toBe(RUNNER_IMAGE);
        // Only the secret bundle is mounted via envFrom; non-secret config
        // (SENTRY_ENV) is injected as explicit env, not a ConfigMap.
        expect(c.envFrom?.map((e) => e.secretRef?.name ?? e.configMapRef?.name)).toEqual(["previewkit-env-file"]);

        const spec = jobSpecEnv(job);
        expect(spec.mode).toBe("deploy");
        expect(spec.event.repoFullName).toBe("acme/widgets");
        expect(spec.event.prNumber).toBe(42);

        // DATABASE_URL is injected as an explicit env var (not via envFrom), so it
        // overrides the production DB URL the shared previewkit-env-file secret
        // carries - the runner writes to the launching API's own DB.
        expect(c.env?.find((e) => e.name === "DATABASE_URL")?.value).toBe(DATABASE_URL);
        // SENTRY_ENV is injected from the launching API's own config, replacing the
        // former previewkit-runner-env ConfigMap.
        expect(c.env?.find((e) => e.name === "SENTRY_ENV")?.value).toBe(SENTRY_ENV);
    });

    it("supersedes an in-flight deploy job (Background delete) before creating the new one", async () => {
        const api = new FakeJobsApi();
        api.existingJobs = [{ metadata: { name: "pk-deploy-acme-widgets-42-oldid" } }];

        await launcher(api).launchDeploy({ event });

        const envKey = previewEnvKey(event.repoFullName, event.prNumber);
        expect(api.listCalls[0]?.labelSelector).toBe(
            `previewkit.dev/env=${envKey},previewkit.dev/type in (deploy,redeploy-app)`,
        );
        expect(api.deleteCalls).toEqual([
            { name: "pk-deploy-acme-widgets-42-oldid", namespace: JOB_NAMESPACE, propagationPolicy: "Background" },
        ]);
        expect(api.createdJobs).toHaveLength(1);
    });

    it("reads the runner image from imageNamespace but creates the Job in jobNamespace", async () => {
        const api = new FakeJobsApi();
        const cms = new FakeConfigMaps(RUNNER_IMAGE);
        await launcher(api, cms).launchDeploy({ event });

        // Per-env image pin is read from the API's own namespace...
        expect(cms.readNamespaces).toEqual([IMAGE_NAMESPACE]);
        // ...while the Job runs in the shared previewkit namespace.
        expect(api.createNamespaces).toEqual([JOB_NAMESPACE]);
        expect(container(api.createdJobs[0] ?? ({} as V1Job)).image).toBe(RUNNER_IMAGE);
    });

    it("passes the pinned configRevisionId through to the runner spec", async () => {
        const api = new FakeJobsApi();
        await launcher(api).launchDeploy({ event, configRevisionId: "rev_123" });

        const job = api.createdJobs[0];
        if (job == null) throw new Error("no job created");
        expect(jobSpecEnv(job).configRevisionId).toBe("rev_123");
    });

    it("throws (without superseding or creating) when the runner image is unresolved", async () => {
        const api = new FakeJobsApi();
        api.existingJobs = [{ metadata: { name: "pk-deploy-acme-widgets-42-oldid" } }];
        const noImage = new FakeConfigMaps(undefined);

        await expect(launcher(api, noImage).launchDeploy({ event })).rejects.toThrow(/previewkit-runner-image/);
        // Image resolution runs first: a running deploy is never killed when we
        // cannot launch a replacement.
        expect(api.deleteCalls).toHaveLength(0);
        expect(api.createdJobs).toHaveLength(0);
    });
});

describe("PreviewkitJobLauncher.launchTeardown", () => {
    it("creates a teardown job and supersedes the in-flight deploy family", async () => {
        const api = new FakeJobsApi();
        await launcher(api).launchTeardown({ event });

        expect(api.listCalls[0]?.labelSelector).toContain("previewkit.dev/type in (deploy,redeploy-app)");
        expect(api.createdJobs).toHaveLength(1);

        const job = api.createdJobs[0];
        if (job == null) throw new Error("no job created");
        expect(job.metadata?.generateName).toMatch(/^pk-teardown-acme-widgets-42-$/);
        expect(job.metadata?.labels?.["previewkit.dev/type"]).toBe("teardown");
        expect(container(job).image).toBe(RUNNER_IMAGE);
        expect(jobSpecEnv(job).mode).toBe("teardown");
    });
});

describe("PreviewkitJobLauncher.launchRedeployApp", () => {
    it("creates a redeploy-app job carrying the app + mode, superseding the deploy family", async () => {
        const api = new FakeJobsApi();
        await launcher(api).launchRedeployApp({
            event,
            namespace: "preview-acme-widgets-pr-42",
            appName: "web",
            mode: "rebuild",
            configRevisionId: "rev_9",
        });

        const envKey = previewEnvKey(event.repoFullName, event.prNumber);
        expect(api.listCalls[0]?.labelSelector).toBe(
            `previewkit.dev/env=${envKey},previewkit.dev/type in (deploy,redeploy-app)`,
        );
        expect(api.createdJobs).toHaveLength(1);

        const job = api.createdJobs[0];
        if (job == null) throw new Error("no job created");
        expect(job.metadata?.generateName).toMatch(/^pk-redeploy-app-acme-widgets-42-$/);
        expect(job.metadata?.labels?.["previewkit.dev/type"]).toBe("redeploy-app");
        expect(container(job).image).toBe(RUNNER_IMAGE);

        const spec = jobSpecEnv(job);
        expect(spec.mode).toBe("redeploy-app");
        expect(spec.namespace).toBe("preview-acme-widgets-pr-42");
        expect(spec.appName).toBe("web");
        expect(spec.redeployMode).toBe("rebuild");
        expect(spec.configRevisionId).toBe("rev_9");
    });
});

describe("previewEnvKey", () => {
    it("is deterministic and label-safe even for very long repo names", () => {
        const long = `${"x".repeat(200)}/${"y".repeat(200)}`;
        const key = previewEnvKey(long, 12345);

        expect(previewEnvKey(long, 12345)).toBe(key);
        expect(key.length).toBeLessThanOrEqual(63);
        expect(key).toMatch(/^[a-z0-9]([-a-z0-9_.]*[a-z0-9])?$/);
        // Distinct repos / PRs map to distinct keys.
        expect(previewEnvKey("acme/widgets", 42)).not.toBe(previewEnvKey("acme/gadgets", 42));
        expect(previewEnvKey("acme/widgets", 42)).not.toBe(previewEnvKey("acme/widgets", 43));
    });
});
