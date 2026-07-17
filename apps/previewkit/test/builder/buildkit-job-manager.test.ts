import type { CoreV1Event, V1Job, V1Pod } from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildAbortedError, BuildError } from "../../src/builder/builder";
import { BuildKitJobManager } from "../../src/builder/buildkit-job-manager";
import { BUILD_MESSAGES } from "../../src/builder/messages";

interface CreatedJob {
    namespace: string;
    body: V1Job;
}

interface DeletedJob {
    name: string;
    namespace: string;
    propagationPolicy?: string;
}

class FakeBuildJobsApi {
    readonly createdJobs: CreatedJob[] = [];
    readonly deletedJobs: DeletedJob[] = [];
    createError?: Error;
    deleteFailuresRemaining = 0;

    async createNamespacedJob(params: CreatedJob): Promise<V1Job> {
        this.createdJobs.push(params);
        if (this.createError != null) throw this.createError;
        return params.body;
    }

    async deleteNamespacedJob(params: DeletedJob): Promise<unknown> {
        this.deletedJobs.push(params);
        if (this.deleteFailuresRemaining > 0) {
            this.deleteFailuresRemaining -= 1;
            throw new Error("temporary delete failure");
        }
        return {};
    }
}

class FakeBuildPodsApi {
    readCount = 0;
    readonly eventQueries: string[] = [];
    events: CoreV1Event[] = [];
    eventsError?: Error;

    constructor(private readonly responses: V1Pod[][]) {}

    async listNamespacedPod(): Promise<{ items: V1Pod[] }> {
        const responseIndex = Math.min(this.readCount, Math.max(0, this.responses.length - 1));
        this.readCount += 1;
        return { items: this.responses[responseIndex] ?? [] };
    }

    async listNamespacedEvent(params: {
        namespace: string;
        fieldSelector?: string;
    }): Promise<{ items: CoreV1Event[] }> {
        this.eventQueries.push(params.fieldSelector ?? "");
        if (this.eventsError != null) throw this.eventsError;
        return { items: this.events };
    }
}

const dialAlwaysSucceeds = async (): Promise<void> => {};

describe("BuildKitJobManager", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("creates an isolated rootful buildkitd Job and returns its pod endpoint", async () => {
        const batchApi = new FakeBuildJobsApi();
        const podsApi = new FakeBuildPodsApi([[readyPod("10.40.0.12")]]);
        const manager = createManager(batchApi, podsApi);

        const instance = await manager.provision();

        expect(instance.name).toMatch(/^buildkit-[a-f0-9]{16}$/);
        expect(instance.host).toBe("tcp://10.40.0.12:1234");
        expect(batchApi.createdJobs).toHaveLength(1);
        const job = batchApi.createdJobs[0]?.body;
        if (job == null) throw new Error("Expected a created buildkit Job");
        const podSpec = job.spec?.template.spec;
        const container = podSpec?.containers[0];

        expect(job.metadata?.labels?.["previewkit.dev/type"]).toBe("build");
        expect(job.spec?.backoffLimit).toBe(0);
        expect(job.spec?.activeDeadlineSeconds).toBe(2640);
        expect(podSpec?.serviceAccountName).toBeUndefined();
        expect(podSpec?.automountServiceAccountToken).toBe(false);
        expect(podSpec?.enableServiceLinks).toBe(false);
        expect(podSpec?.nodeSelector).toEqual({ "kubernetes.io/arch": "amd64", pool: "buildkit" });
        expect(podSpec?.tolerations).toContainEqual({
            key: "pool",
            operator: "Equal",
            value: "buildkit",
            effect: "NoSchedule",
        });
        expect(
            podSpec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms[0]
                ?.matchExpressions,
        ).toEqual([
            {
                key: "karpenter.k8s.aws/instance-category",
                operator: "In",
                values: ["m"],
            },
            {
                key: "karpenter.k8s.aws/instance-generation",
                operator: "In",
                values: ["6", "7", "8"],
            },
            {
                key: "karpenter.k8s.aws/instance-size",
                operator: "In",
                values: ["xlarge"],
            },
        ]);
        expect(podSpec?.affinity?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution).toEqual([
            {
                weight: 50,
                preference: {
                    matchExpressions: [
                        {
                            key: "karpenter.k8s.aws/instance-generation",
                            operator: "In",
                            values: ["8"],
                        },
                    ],
                },
            },
            {
                weight: 100,
                preference: {
                    matchExpressions: [
                        {
                            key: "karpenter.k8s.aws/instance-generation",
                            operator: "In",
                            values: ["7", "8"],
                        },
                    ],
                },
            },
        ]);
        expect(podSpec?.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution).toEqual([
            {
                labelSelector: {
                    matchLabels: { "previewkit.dev/type": "build" },
                },
                topologyKey: "kubernetes.io/hostname",
            },
        ]);
        expect(container?.image).toBe("moby/buildkit:v0.31.1");
        expect(container?.args).not.toContain("--oci-worker-no-process-sandbox");
        expect(container?.securityContext).toEqual({ privileged: true, runAsUser: 0, runAsGroup: 0 });
        expect(podSpec?.securityContext).toBeUndefined();
        expect(container?.volumeMounts).toContainEqual({ name: "cache", mountPath: "/var/lib/buildkit" });
        expect(container?.resources).toBeUndefined();
        expect(podSpec?.volumes).toContainEqual({
            name: "buildkitd-config",
            configMap: { name: "buildkitd-ephemeral-config" },
        });
        expect(podSpec?.volumes).toContainEqual({ name: "cache", emptyDir: {} });

        await manager.release(instance);
        expect(batchApi.deletedJobs).toEqual([
            { name: instance.name, namespace: "buildkit", propagationPolicy: "Background" },
        ]);
    });

    it("deletes the Job when provisioning is aborted", async () => {
        const batchApi = new FakeBuildJobsApi();
        const podsApi = new FakeBuildPodsApi([[]]);
        const manager = createManager(batchApi, podsApi);
        const abortController = new AbortController();

        const provisionResult = manager.provision(abortController.signal).catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(0);
        abortController.abort(new Error("superseded"));
        const error = await provisionResult;

        expect(error).toBeInstanceOf(BuildAbortedError);
        expect(batchApi.deletedJobs).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("polls the pod API every two seconds while waiting for a node", async () => {
        const batchApi = new FakeBuildJobsApi();
        const podsApi = new FakeBuildPodsApi([[], [readyPod("10.40.0.15")]]);
        const manager = createManager(batchApi, podsApi, 10_000);

        const provisionResult = manager.provision();
        await vi.advanceTimersByTimeAsync(0);
        expect(podsApi.readCount).toBe(1);

        await vi.advanceTimersByTimeAsync(1_999);
        expect(podsApi.readCount).toBe(1);

        await vi.advanceTimersByTimeAsync(1);
        await expect(provisionResult).resolves.toMatchObject({ host: "tcp://10.40.0.15:1234" });
        expect(podsApi.readCount).toBe(3);
    });

    it("surfaces a capacity-specific message when node scheduling times out", async () => {
        const batchApi = new FakeBuildJobsApi();
        const podsApi = new FakeBuildPodsApi([[]]);
        const manager = createManager(batchApi, podsApi);

        const provisionResult = manager.provision().catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(2_000);
        const error = await provisionResult;

        expect(error).toBeInstanceOf(BuildError);
        if (!(error instanceof BuildError)) throw new Error("Expected BuildError");
        expect(error.isTransient).toBe(true);
        expect(error.message).toContain("scheduled onto a node");
        expect(error.message).toContain("no pod exists for the build Job");
        expect(error.userFacingMessage).toBe(BUILD_MESSAGES.capacityUnavailable);
        expect(podsApi.eventQueries[0]).toMatch(/^involvedObject\.name=buildkit-[a-f0-9]{16}$/);
        expect(batchApi.deletedJobs).toHaveLength(1);
    });

    it("embeds the pod state and recent events when daemon startup times out", async () => {
        const batchApi = new FakeBuildJobsApi();
        const podsApi = new FakeBuildPodsApi([[scheduledNotReadyPod()]]);
        podsApi.events = [
            podEvent("Pulling", 'Pulling image "moby/buildkit:v0.31.1"', 1),
            podEvent("Unhealthy", "Readiness probe failed: dial tcp 10.40.0.12:1234: connect: connection refused", 12),
        ];
        const manager = createManager(batchApi, podsApi);

        const provisionResult = manager.provision().catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(4_000);
        const error = await provisionResult;

        expect(error).toBeInstanceOf(BuildError);
        if (!(error instanceof BuildError)) throw new Error("Expected BuildError");
        expect(error.isTransient).toBe(true);
        expect(error.message).toContain("become Ready");
        expect(error.message).toContain("pod=pk-builder-pod");
        expect(error.message).toContain("node=ip-10-40-0-99");
        expect(error.message).toContain(
            "Ready=False (ContainersNotReady: containers with unready status: [buildkitd])",
        );
        expect(error.message).toContain('Pulling: Pulling image "moby/buildkit:v0.31.1"');
        expect(error.message).toContain("Unhealthy x12: Readiness probe failed");
        expect(podsApi.eventQueries).toEqual(["involvedObject.name=pk-builder-pod"]);
        expect(batchApi.deletedJobs).toHaveLength(1);
    });

    it("still reports the timeout when the events read fails", async () => {
        const batchApi = new FakeBuildJobsApi();
        const podsApi = new FakeBuildPodsApi([[scheduledNotReadyPod()]]);
        podsApi.eventsError = new Error("events is forbidden");
        const manager = createManager(batchApi, podsApi);

        const provisionResult = manager.provision().catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(4_000);
        const error = await provisionResult;

        expect(error).toBeInstanceOf(BuildError);
        if (!(error instanceof BuildError)) throw new Error("Expected BuildError");
        expect(error.message).toContain("pod=pk-builder-pod");
        expect(error.message).toContain("No events found");
        expect(batchApi.deletedJobs).toHaveLength(1);
    });

    it("classifies an image pull failure as transient and cleans up", async () => {
        const batchApi = new FakeBuildJobsApi();
        const podsApi = new FakeBuildPodsApi([[failedPod("ImagePullBackOff")]]);
        const manager = createManager(batchApi, podsApi);

        const error = await manager.provision().catch((err: unknown) => err);

        expect(error).toBeInstanceOf(BuildError);
        if (!(error instanceof BuildError)) throw new Error("Expected BuildError");
        expect(error.isTransient).toBe(true);
        expect(error.userFacingMessage).toBe(BUILD_MESSAGES.infrastructureUnavailable);
        expect(error.message).toContain("ImagePullBackOff");
        expect(batchApi.deletedJobs).toHaveLength(1);
    });

    it("classifies an invalid image name as permanent", async () => {
        const batchApi = new FakeBuildJobsApi();
        const manager = createManager(batchApi, new FakeBuildPodsApi([[failedPod("InvalidImageName")]]));

        const error = await manager.provision().catch((err: unknown) => err);

        expect(error).toBeInstanceOf(BuildError);
        if (!(error instanceof BuildError)) throw new Error("Expected BuildError");
        expect(error.isTransient).toBe(false);
        expect(batchApi.deletedJobs).toHaveLength(1);
    });

    it("attempts cleanup when Job creation returns an ambiguous error", async () => {
        const batchApi = new FakeBuildJobsApi();
        batchApi.createError = new Error("request timed out after the API accepted it");
        const manager = createManager(batchApi, new FakeBuildPodsApi([[]]));

        const error = await manager.provision().catch((err: unknown) => err);

        expect(error).toBeInstanceOf(BuildError);
        if (!(error instanceof BuildError)) throw new Error("Expected BuildError");
        expect(error.isTransient).toBe(true);
        expect(error.message).toContain("request timed out");
        expect(batchApi.deletedJobs).toHaveLength(1);
        expect(batchApi.deletedJobs[0]?.name).toMatch(/^buildkit-/);
    });

    it("releaseAll retries Jobs whose first cleanup failed", async () => {
        const batchApi = new FakeBuildJobsApi();
        const manager = createManager(batchApi, new FakeBuildPodsApi([[readyPod("10.40.0.13")]]));
        const instance = await manager.provision();
        batchApi.deleteFailuresRemaining = 1;

        await expect(manager.release(instance)).rejects.toThrow("temporary delete failure");
        await expect(manager.releaseAll()).resolves.toBeUndefined();

        expect(batchApi.deletedJobs).toHaveLength(2);
    });

    it("releases every active Job during runner shutdown", async () => {
        const batchApi = new FakeBuildJobsApi();
        const manager = createManager(batchApi, new FakeBuildPodsApi([[readyPod("10.40.0.14")]]));

        const first = await manager.provision();
        const second = await manager.provision();
        await manager.releaseAll();

        expect(batchApi.deletedJobs.map((job) => job.name).sort()).toEqual([first.name, second.name].sort());
    });

    it("retries an unknown terminal daemon exit with a fresh Job", async () => {
        const batchApi = new FakeBuildJobsApi();
        const manager = createManager(batchApi, new FakeBuildPodsApi([[terminatedPod("Error", 143)]]));

        const error = await manager.provision().catch((err: unknown) => err);

        expect(error).toBeInstanceOf(BuildError);
        if (!(error instanceof BuildError)) throw new Error("Expected BuildError");
        expect(error.isTransient).toBe(true);
        expect(error.message).toContain("exit 143");
        expect(batchApi.deletedJobs).toHaveLength(1);
    });

    it("stamps deploy identity labels onto the Job and pod for kubectl lookups", async () => {
        const batchApi = new FakeBuildJobsApi();
        const podsApi = new FakeBuildPodsApi([[readyPod("10.40.0.20")]]);
        const manager = createManager(batchApi, podsApi);

        await manager.provision(undefined, {
            appName: "api-gateway",
            namespace: "preview-acme-bank-pr-42",
            repo: "acme/bank",
            pr: 42,
        });

        const job = batchApi.createdJobs[0]?.body;
        if (job == null) throw new Error("Expected a created buildkit Job");
        expect(job.metadata?.labels?.["previewkit.dev/app"]).toBe("api-gateway");
        expect(job.metadata?.labels?.["previewkit.dev/namespace"]).toBe("preview-acme-bank-pr-42");
        // `/` is not a valid label-value char, so it is sanitized to `-`.
        expect(job.metadata?.labels?.["previewkit.dev/repo"]).toBe("acme-bank");
        expect(job.metadata?.labels?.["previewkit.dev/pr"]).toBe("42");
        // The pod template carries the same labels so a `kubectl -l` selector finds the pod.
        expect(job.spec?.template.metadata?.labels?.["previewkit.dev/pr"]).toBe("42");
    });
});

function createManager(
    batchApi: FakeBuildJobsApi,
    podsApi: FakeBuildPodsApi,
    provisionTimeoutMs = 2_000,
): BuildKitJobManager {
    return new BuildKitJobManager({
        batchApi,
        podsApi,
        namespace: "buildkit",
        image: "moby/buildkit:v0.31.1",
        activeDeadlineSeconds: 2640,
        provisionTimeoutMs,
        startupTimeoutMs: 2_000,
        dial: dialAlwaysSucceeds,
    });
}

function readyPod(podIP: string): V1Pod {
    return {
        metadata: { name: "pk-builder-pod" },
        status: {
            podIP,
            conditions: [
                { type: "PodScheduled", status: "True" },
                { type: "Ready", status: "True" },
            ],
        },
    };
}

function scheduledNotReadyPod(): V1Pod {
    return {
        metadata: { name: "pk-builder-pod" },
        spec: { nodeName: "ip-10-40-0-99", containers: [] },
        status: {
            phase: "Running",
            conditions: [
                { type: "PodScheduled", status: "True" },
                {
                    type: "Ready",
                    status: "False",
                    reason: "ContainersNotReady",
                    message: "containers with unready status: [buildkitd]",
                },
            ],
            containerStatuses: [
                {
                    name: "buildkitd",
                    image: "moby/buildkit:v0.31.1",
                    imageID: "",
                    ready: false,
                    restartCount: 0,
                    state: { running: {} },
                },
            ],
        },
    };
}

function podEvent(reason: string, message: string, count: number): CoreV1Event {
    return {
        metadata: { name: `pk-builder-pod.${reason.toLowerCase()}` },
        involvedObject: { name: "pk-builder-pod" },
        reason,
        message,
        count,
    };
}

function failedPod(reason: string): V1Pod {
    return {
        metadata: { name: "pk-builder-pod" },
        status: {
            conditions: [],
            containerStatuses: [
                {
                    name: "buildkitd",
                    image: "moby/buildkit:v0.31.1",
                    imageID: "",
                    ready: false,
                    restartCount: 0,
                    state: { waiting: { reason } },
                },
            ],
        },
    };
}

function terminatedPod(reason: string, exitCode: number): V1Pod {
    return {
        metadata: { name: "pk-builder-pod" },
        status: {
            phase: "Failed",
            containerStatuses: [
                {
                    name: "buildkitd",
                    image: "moby/buildkit:v0.31.1",
                    imageID: "",
                    ready: false,
                    restartCount: 0,
                    state: { terminated: { reason, exitCode } },
                },
            ],
        },
    };
}
