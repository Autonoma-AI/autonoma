import type { PreviewDeployTarget } from "@autonoma/types";
import { ApiException, type V1Job } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
// The launcher module, not the package barrel: the barrel also exports the in-cluster factory, whose env module
// validates DATABASE_URL at import. Nothing here needs a database.
import {
    type ConfigMapReader,
    PreviewkitJobLauncher,
    type PreviewJobsApi,
    previewEnvKey,
} from "../src/previewkit-jobs/previewkit-job-launcher";

// The Job is created in the shared previewkit namespace; the runner-image
// ConfigMap is read from the launcher's own (per-env) namespace.
const JOB_NAMESPACE = "previewkit";
const IMAGE_NAMESPACE = "beta";
const RUNNER_IMAGE = "registry/beta/previewkit:abc123def";
const DATABASE_URL = "postgresql://user:pass@beta-db:5432/beta";
const SENTRY_ENV = "beta";

const target: PreviewDeployTarget = {
    prNumber: 42,
    repoFullName: "acme/widgets",
    organizationId: "org_1",
    githubRepositoryId: 99,
    headSha: "abc123def4567890",
    headRef: "feature/x",
};

/** Records every Batch API call and returns whatever jobs the test seeds. */
class FakeJobsApi implements PreviewJobsApi {
    existingJobs: V1Job[] = [];
    readonly listCalls: Array<{ namespace: string; labelSelector?: string }> = [];
    readonly deleteCalls: Array<{ name: string; namespace: string; propagationPolicy?: string }> = [];
    readonly createdJobs: V1Job[] = [];
    readonly createNamespaces: string[] = [];
    readonly readCalls: Array<{ name: string; namespace: string }> = [];
    /** When set, every delete throws it - the hook for a Job that is already gone. */
    deleteError?: unknown;
    /** When set, the read throws it instead of answering from `existingJobs`. */
    readError?: unknown;
    /** Stands in for the API server's generateName suffix, so every created Job gets a distinct name. */
    private assignedNames = 0;

    async listNamespacedJob(params: { namespace: string; labelSelector?: string }): Promise<{ items: V1Job[] }> {
        this.listCalls.push(params);
        return { items: this.existingJobs };
    }
    async readNamespacedJob(params: { name: string; namespace: string }): Promise<V1Job> {
        this.readCalls.push(params);
        if (this.readError != null) throw this.readError;
        const job = this.existingJobs.find((candidate) => candidate.metadata?.name === params.name);
        if (job == null) throw new ApiException(404, "not found", undefined, {});
        return job;
    }
    async createNamespacedJob(params: { namespace: string; body: V1Job }): Promise<V1Job> {
        this.createNamespaces.push(params.namespace);
        this.createdJobs.push(params.body);
        // The API server assigns `name` from `generateName`; the launcher returns it so a build can later be
        // cancelled by name rather than by the per-(repo, PR) env label.
        this.assignedNames += 1;
        return {
            ...params.body,
            metadata: {
                ...params.body.metadata,
                name: `${params.body.metadata?.generateName ?? ""}${this.assignedNames}`,
            },
        };
    }
    async deleteNamespacedJob(params: {
        name: string;
        namespace: string;
        propagationPolicy?: string;
    }): Promise<unknown> {
        this.deleteCalls.push(params);
        if (this.deleteError != null) throw this.deleteError;
        return {};
    }
}

/** Returns the runner-image ConfigMap; `image` undefined simulates a missing key. */
class FakeConfigMaps implements ConfigMapReader {
    readonly readNames: string[] = [];
    readonly readNamespaces: string[] = [];
    constructor(private readonly image: string | undefined) {}
    async readNamespacedConfigMap(params: {
        name: string;
        namespace: string;
    }): Promise<{ data?: Record<string, string> }> {
        this.readNames.push(params.name);
        this.readNamespaces.push(params.namespace);
        return { data: this.image != null ? { image: this.image } : {} };
    }
}

const SECRETS_CMK = "arn:aws:kms:us-east-1:1:key/test";

function launcher(api: FakeJobsApi, cms: ConfigMapReader = new FakeConfigMaps(RUNNER_IMAGE)): PreviewkitJobLauncher {
    return new PreviewkitJobLauncher({
        batchApi: api,
        coreApi: cms,
        jobNamespace: JOB_NAMESPACE,
        imageNamespace: IMAGE_NAMESPACE,
        databaseUrl: DATABASE_URL,
        sentryEnv: SENTRY_ENV,
        secretsCmk: SECRETS_CMK,
    });
}

function container(job: V1Job) {
    const c = job.spec?.template.spec?.containers[0];
    if (c == null) throw new Error("job has no container");
    return c;
}

function jobSpecEnv(job: V1Job): {
    mode: string;
    target: PreviewDeployTarget;
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
        await launcher(api).launchDeploy(target);

        expect(api.deleteCalls).toHaveLength(0);
        expect(api.createdJobs).toHaveLength(1);

        const job = api.createdJobs[0];
        if (job == null) throw new Error("no job created");
        const envKey = previewEnvKey(target.repoFullName, target.prNumber);

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
        expect(spec.target.repoFullName).toBe("acme/widgets");
        expect(spec.target.prNumber).toBe(42);

        // DATABASE_URL is injected as an explicit env var (not via envFrom), so it
        // overrides the production DB URL the shared previewkit-env-file secret
        // carries - the runner writes to the launching API's own DB.
        expect(c.env?.find((e) => e.name === "DATABASE_URL")?.value).toBe(DATABASE_URL);
        // SENTRY_ENV is injected from the launching API's own config, replacing the
        // former previewkit-runner-env ConfigMap.
        expect(c.env?.find((e) => e.name === "SENTRY_ENV")?.value).toBe(SENTRY_ENV);
        // The CMK has to travel with DATABASE_URL: the key it names lives in the database
        // that URL points at, so a runner pointed at beta's DB must not inherit the
        // production value from the shared previewkit-env-file secret.
        expect(c.env?.find((e) => e.name === "PREVIEWKIT_SECRETS_CMK")?.value).toBe(SECRETS_CMK);
    });

    it("supersedes an in-flight deploy job (Background delete) before creating the new one", async () => {
        const api = new FakeJobsApi();
        api.existingJobs = [{ metadata: { name: "pk-deploy-acme-widgets-42-oldid" } }];

        await launcher(api).launchDeploy(target);

        const envKey = previewEnvKey(target.repoFullName, target.prNumber);
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
        await launcher(api, cms).launchDeploy(target);

        // Per-env image pin is read from the API's own namespace...
        expect(cms.readNamespaces).toEqual([IMAGE_NAMESPACE]);
        expect(cms.readNames).toEqual(["previewkit-runner-image"]);
        // ...while the Job runs in the shared previewkit namespace.
        expect(api.createNamespaces).toEqual([JOB_NAMESPACE]);
        const job = api.createdJobs[0];
        if (job == null) throw new Error("no job created");
        expect(container(job).image).toBe(RUNNER_IMAGE);
    });

    it("throws (without superseding or creating) when the runner image is unresolved", async () => {
        const api = new FakeJobsApi();
        api.existingJobs = [{ metadata: { name: "pk-deploy-acme-widgets-42-oldid" } }];
        const noImage = new FakeConfigMaps(undefined);

        await expect(launcher(api, noImage).launchDeploy(target)).rejects.toThrow(/previewkit-runner-image/);
        // Image resolution runs first: a running deploy is never killed when we
        // cannot launch a replacement.
        expect(api.deleteCalls).toHaveLength(0);
        expect(api.createdJobs).toHaveLength(0);
    });

    // The server-assigned name is the only handle identifying THIS commit's Job; the env label is shared by
    // every commit of the PR.
    it("returns the name the API server assigned to the created Job", async () => {
        const api = new FakeJobsApi();

        const jobName = await launcher(api).launchDeploy(target);

        // `createdJobs` records the REQUEST, which carries only the generateName prefix; the name comes back on
        // the response, so the launcher must surface that rather than what it sent.
        expect(api.createdJobs[0]?.metadata?.name).toBeUndefined();
        expect(jobName.startsWith("pk-deploy-acme-widgets-42-")).toBe(true);
        expect(jobName).not.toBe(api.createdJobs[0]?.metadata?.generateName);
    });
});

describe("PreviewkitJobLauncher.cancelDeploy", () => {
    // Never the env label: it is per (repo, PR), so a late delete would kill whichever newer commit had launched.
    it("deletes exactly the named Job, without listing by label", async () => {
        const api = new FakeJobsApi();

        await launcher(api).cancelDeploy("pk-deploy-acme-widgets-42-abc");

        expect(api.deleteCalls).toEqual([
            { name: "pk-deploy-acme-widgets-42-abc", namespace: JOB_NAMESPACE, propagationPolicy: "Background" },
        ]);
        expect(api.listCalls).toHaveLength(0);
    });

    // A Job that already finished or was superseded is gone; that is the expected outcome, not a failure.
    it("treats an already-gone Job as success", async () => {
        const api = new FakeJobsApi();
        api.deleteError = new ApiException(404, "not found", undefined, {});

        await expect(launcher(api).cancelDeploy("pk-deploy-gone")).resolves.toBeUndefined();
    });
});

describe("PreviewkitJobLauncher.getDeployJobState", () => {
    const job = (status: V1Job["status"]): V1Job => ({ metadata: { name: "pk-deploy-1" }, status });

    it("reports a Job with neither condition set as still running", async () => {
        const api = new FakeJobsApi();
        api.existingJobs = [job({ active: 1 })];

        await expect(launcher(api).getDeployJobState("pk-deploy-1")).resolves.toBe("running");
        expect(api.readCalls).toEqual([{ name: "pk-deploy-1", namespace: JOB_NAMESPACE }]);
    });

    it("reports a completed Job as succeeded", async () => {
        const api = new FakeJobsApi();
        api.existingJobs = [job({ succeeded: 1, conditions: [{ type: "Complete", status: "True" }] })];

        await expect(launcher(api).getDeployJobState("pk-deploy-1")).resolves.toBe("succeeded");
    });

    it("reports a succeeded pod as succeeded before the Complete condition lands", async () => {
        const api = new FakeJobsApi();
        api.existingJobs = [job({ succeeded: 1 })];

        await expect(launcher(api).getDeployJobState("pk-deploy-1")).resolves.toBe("succeeded");
    });

    // backoffLimit is 1, so the first pod failure leaves `failed: 1` with a retry still to come.
    it("keeps a Job with a failed pod but no Failed condition as running", async () => {
        const api = new FakeJobsApi();
        api.existingJobs = [job({ failed: 1 })];

        await expect(launcher(api).getDeployJobState("pk-deploy-1")).resolves.toBe("running");
    });

    it("reports a Job out of retries as failed", async () => {
        const api = new FakeJobsApi();
        api.existingJobs = [job({ failed: 2, conditions: [{ type: "Failed", status: "True" }] })];

        await expect(launcher(api).getDeployJobState("pk-deploy-1")).resolves.toBe("failed");
    });

    it("reports a Job that no longer exists as gone", async () => {
        const api = new FakeJobsApi();

        await expect(launcher(api).getDeployJobState("pk-deploy-1")).resolves.toBe("gone");
    });

    it("rethrows a non-404 read failure", async () => {
        const api = new FakeJobsApi();
        api.readError = new ApiException(403, "forbidden", undefined, {});

        await expect(launcher(api).getDeployJobState("pk-deploy-1")).rejects.toThrow();
    });
});

describe("PreviewkitJobLauncher.launchTeardown", () => {
    it("creates a teardown job and supersedes the in-flight deploy family", async () => {
        const api = new FakeJobsApi();
        await launcher(api).launchTeardown(target);

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
            target,
            namespace: "preview-acme-widgets-pr-42",
            appName: "web",
            mode: "rebuild",
        });

        const envKey = previewEnvKey(target.repoFullName, target.prNumber);
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
