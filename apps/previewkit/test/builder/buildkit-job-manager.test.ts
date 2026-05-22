import * as k8s from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildError } from "../../src/builder/builder";
import { BuildKitJobManager } from "../../src/builder/buildkit-job-manager";

interface CreatedJob {
    namespace: string;
    body: k8s.V1Job;
}
interface CreatedService {
    namespace: string;
    body: k8s.V1Service;
}
interface DeletedJob {
    namespace: string;
    name: string;
    propagationPolicy?: string;
}

class FakeBatchV1Api {
    createdJobs: CreatedJob[] = [];
    deletedJobs: DeletedJob[] = [];
    notFoundOnDelete = false;
    nextJobUid = "uid-1";

    async createNamespacedJob(args: { namespace: string; body: k8s.V1Job }): Promise<k8s.V1Job> {
        this.createdJobs.push(args);
        return {
            ...args.body,
            metadata: { ...args.body.metadata, uid: this.nextJobUid },
        };
    }

    async deleteNamespacedJob(args: { namespace: string; name: string; propagationPolicy?: string }): Promise<unknown> {
        this.deletedJobs.push(args);
        if (this.notFoundOnDelete) {
            const err = new k8s.ApiException(404, "not found", "", {});
            throw err;
        }
        return {};
    }
}

class FakeCoreV1Api {
    createdServices: CreatedService[] = [];
    /** Sequence of pod-list responses; one consumed per call until empty,
     *  then the last one repeats. Lets a test simulate "no pod -> pending pod
     *  -> ready pod" across multiple poll iterations. */
    podListSequence: k8s.V1PodList[] = [];

    async createNamespacedService(args: { namespace: string; body: k8s.V1Service }): Promise<k8s.V1Service> {
        this.createdServices.push(args);
        return args.body;
    }

    async listNamespacedPod(_args: { namespace: string; labelSelector?: string }): Promise<k8s.V1PodList> {
        return this.podListSequence.length > 1
            ? this.podListSequence.shift()!
            : (this.podListSequence[0] ?? { items: [] });
    }
}

interface PodCondition {
    ready?: boolean;
    /** Container `state.waiting.reason` (e.g. ImagePullBackOff). */
    failedReason?: string;
    /** Pod-level `status.phase = Failed` + `status.reason = Evicted` (kubelet
     *  evicted due to node pressure). */
    evicted?: boolean;
    /** Container `state.terminated.reason = OOMKilled`. */
    oomKilled?: boolean;
}

function podWith(condition: PodCondition): k8s.V1Pod {
    const containerStatuses: k8s.V1ContainerStatus[] = [];
    if (condition.failedReason != null) {
        containerStatuses.push({
            name: "buildkitd",
            ready: false,
            restartCount: 0,
            image: "moby/buildkit",
            imageID: "",
            state: { waiting: { reason: condition.failedReason, message: "pull failed" } },
        } as unknown as k8s.V1ContainerStatus);
    }
    if (condition.oomKilled === true) {
        containerStatuses.push({
            name: "buildkitd",
            ready: false,
            restartCount: 0,
            image: "moby/buildkit",
            imageID: "",
            state: { terminated: { reason: "OOMKilled", exitCode: 137 } },
        } as unknown as k8s.V1ContainerStatus);
    }
    return {
        metadata: { name: "bk-pod-1" },
        status: {
            conditions: condition.ready === true ? [{ type: "Ready", status: "True" }] : [],
            phase: condition.evicted === true ? "Failed" : undefined,
            reason: condition.evicted === true ? "Evicted" : undefined,
            message: condition.evicted === true ? "The node was low on resource: memory." : undefined,
            containerStatuses,
        },
    };
}

function makeKc(): { kc: k8s.KubeConfig; batch: FakeBatchV1Api; core: FakeCoreV1Api } {
    const batch = new FakeBatchV1Api();
    const core = new FakeCoreV1Api();
    const kc = {
        makeApiClient: (cls: unknown) => {
            if (cls === k8s.BatchV1Api) return batch;
            if (cls === k8s.CoreV1Api) return core;
            throw new Error(`Unexpected API client: ${String(cls)}`);
        },
    } as unknown as k8s.KubeConfig;
    return { kc, batch, core };
}

/** Default dial stub: always resolves immediately. The manager calls this
 *  after the pod reports Ready; in tests we don't have a real service. */
const dialAlwaysOk: (host: string, port: number, timeoutMs: number) => Promise<void> = async () => {};

describe("BuildKitJobManager", () => {
    beforeEach(() => {
        // Skip real wall-clock waits between readiness polls; vitest's fake
        // timers makes the test loop deterministic and fast.
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("provisions a Job + Service with matching name and ownerReference", async () => {
        const { kc, batch, core } = makeKc();
        core.podListSequence = [{ items: [podWith({ ready: true })] }];
        const mgr = new BuildKitJobManager({
            kc,
            namespace: "previewkit-builds",
            image: "moby/buildkit:v0.21.1",
            serviceAccountName: "buildkitd",
            activeDeadlineSeconds: 1860,
            dial: dialAlwaysOk,
        });

        const promise = mgr.provision();
        await vi.runAllTimersAsync();
        const instance = await promise;

        expect(instance.name).toMatch(/^pk-builder-[a-f0-9]{16}$/);
        expect(instance.buildId).toMatch(/^[a-f0-9]{16}$/);
        expect(instance.host).toBe(`tcp://${instance.name}.previewkit-builds.svc.cluster.local:1234`);

        // Job was created with the right shape.
        expect(batch.createdJobs).toHaveLength(1);
        const job = batch.createdJobs[0]!.body;
        expect(job.metadata?.name).toBe(instance.name);
        expect(job.spec?.backoffLimit).toBe(0);
        expect(job.spec?.activeDeadlineSeconds).toBe(1860);
        expect(job.spec?.template.spec?.containers[0]?.image).toBe("moby/buildkit:v0.21.1");
        expect(job.spec?.template.spec?.containers[0]?.securityContext?.privileged).toBe(true);
        // SA used by the pod must match the operator's manifest, not a
        // hardcoded string in the source.
        expect(job.spec?.template.spec?.serviceAccountName).toBe("buildkitd");
        // Soft anti-affinity so one build pod per node where possible.
        const antiAffinity =
            job.spec?.template.spec?.affinity?.podAntiAffinity?.preferredDuringSchedulingIgnoredDuringExecution;
        expect(antiAffinity?.[0]?.podAffinityTerm.topologyKey).toBe("kubernetes.io/hostname");

        // Service was created with an ownerReference back to the Job so K8s
        // GC cleans it up when the Job is deleted.
        expect(core.createdServices).toHaveLength(1);
        const svc = core.createdServices[0]!.body;
        expect(svc.metadata?.name).toBe(instance.name);
        expect(svc.metadata?.ownerReferences).toEqual([
            expect.objectContaining({ kind: "Job", name: instance.name, uid: "uid-1", controller: true }),
        ]);
        expect(svc.spec?.selector?.["previewkit.dev/build-id"]).toBe(instance.buildId);
    });

    it("uses different buildIds across provisions (collision-resistant)", async () => {
        const { kc, core } = makeKc();
        core.podListSequence = [{ items: [podWith({ ready: true })] }];
        const mgr = new BuildKitJobManager({
            kc,
            namespace: "previewkit-builds",
            image: "moby/buildkit:v0.21.1",
            serviceAccountName: "buildkitd",
            activeDeadlineSeconds: 1860,
            dial: dialAlwaysOk,
        });

        const seen = new Set<string>();
        for (let i = 0; i < 5; i++) {
            const p = mgr.provision();
            await vi.runAllTimersAsync();
            const inst = await p;
            seen.add(inst.buildId);
        }
        expect(seen.size).toBe(5);
    });

    it("polls until the pod is Ready, then resolves", async () => {
        const { kc, core } = makeKc();
        // Pending → pending → ready
        core.podListSequence = [
            { items: [] },
            { items: [{ metadata: { name: "p1" }, status: { conditions: [] } }] },
            { items: [podWith({ ready: true })] },
        ];
        const mgr = new BuildKitJobManager({
            kc,
            namespace: "previewkit-builds",
            image: "moby/buildkit:v0.21.1",
            serviceAccountName: "buildkitd",
            activeDeadlineSeconds: 1860,
            dial: dialAlwaysOk,
        });

        const promise = mgr.provision();
        await vi.runAllTimersAsync();
        await expect(promise).resolves.toBeDefined();
    });

    it("fails fast (non-transient) when the pod hits ImagePullBackOff", async () => {
        const { kc, core, batch } = makeKc();
        core.podListSequence = [{ items: [podWith({ failedReason: "ImagePullBackOff" })] }];
        const mgr = new BuildKitJobManager({
            kc,
            namespace: "previewkit-builds",
            image: "moby/buildkit:doesnotexist",
            serviceAccountName: "buildkitd",
            activeDeadlineSeconds: 1860,
            dial: dialAlwaysOk,
        });

        const promise = mgr.provision();
        // Catch the rejection eagerly so Node doesn't flag it as briefly
        // unhandled during the fake-timer advance.
        const caught = promise.catch((e) => e);
        await vi.runAllTimersAsync();
        const err = await caught;

        expect(err).toBeInstanceOf(BuildError);
        expect(err.message).toMatch(/ImagePullBackOff/);
        // Config error: retrying won't help, so flag as permanent.
        expect((err as BuildError).isTransient).toBe(false);

        // Cleanup on failure: the Job we created gets deleted, leaving no
        // leak behind even though provisioning didn't complete.
        expect(batch.deletedJobs).toHaveLength(1);
    });

    it("retries (transient) when the pod is evicted", async () => {
        const { kc, core, batch } = makeKc();
        // Kubelet evicted the pod due to node memory pressure - classic
        // case where rescheduling on another node should succeed.
        core.podListSequence = [{ items: [podWith({ evicted: true })] }];
        const mgr = new BuildKitJobManager({
            kc,
            namespace: "previewkit-builds",
            image: "moby/buildkit:v0.21.1",
            serviceAccountName: "buildkitd",
            activeDeadlineSeconds: 1860,
            dial: dialAlwaysOk,
        });

        const promise = mgr.provision();
        const caught = promise.catch((e) => e);
        await vi.runAllTimersAsync();
        const err = await caught;

        expect(err).toBeInstanceOf(BuildError);
        expect(err.message).toMatch(/evicted/i);
        expect(err.message).toMatch(/low on resource/);
        // The whole point: builder's retry loop picks this up.
        expect((err as BuildError).isTransient).toBe(true);
        expect(batch.deletedJobs).toHaveLength(1);
    });

    it("retries (transient) when the buildkit container is OOMKilled at startup", async () => {
        const { kc, core } = makeKc();
        core.podListSequence = [{ items: [podWith({ oomKilled: true })] }];
        const mgr = new BuildKitJobManager({
            kc,
            namespace: "previewkit-builds",
            image: "moby/buildkit:v0.21.1",
            serviceAccountName: "buildkitd",
            activeDeadlineSeconds: 1860,
            dial: dialAlwaysOk,
        });

        const promise = mgr.provision();
        const caught = promise.catch((e) => e);
        await vi.runAllTimersAsync();
        const err = await caught;

        expect(err).toBeInstanceOf(BuildError);
        expect(err.message).toMatch(/OOMKilled/);
        // Another node may have more headroom; cheap to retry.
        expect((err as BuildError).isTransient).toBe(true);
    });

    it("retries the TCP dial until the Service is reachable (covers kube-proxy lag)", async () => {
        const { kc, core } = makeKc();
        core.podListSequence = [{ items: [podWith({ ready: true })] }];

        // Simulate the post-Ready window where the pod IP resolves but
        // kube-proxy hasn't programmed iptables yet: first two dials get
        // ECONNREFUSED, third succeeds.
        let dialAttempts = 0;
        const flakyDial: (host: string, port: number, timeoutMs: number) => Promise<void> = async () => {
            dialAttempts++;
            if (dialAttempts < 3) {
                const err = new Error("connect ECONNREFUSED 172.20.1.2:1234");
                throw err;
            }
        };

        const mgr = new BuildKitJobManager({
            kc,
            namespace: "previewkit-builds",
            image: "moby/buildkit:v0.21.1",
            serviceAccountName: "buildkitd",
            activeDeadlineSeconds: 1860,
            dial: flakyDial,
        });

        const promise = mgr.provision();
        await vi.runAllTimersAsync();
        await expect(promise).resolves.toBeDefined();
        expect(dialAttempts).toBe(3);
    });

    it("release deletes the Job with background propagation", async () => {
        const { kc, batch } = makeKc();
        const mgr = new BuildKitJobManager({
            kc,
            namespace: "previewkit-builds",
            image: "moby/buildkit:v0.21.1",
            serviceAccountName: "buildkitd",
            activeDeadlineSeconds: 1860,
            dial: dialAlwaysOk,
        });

        await mgr.release({ name: "pk-builder-abcd1234efef5678" });

        expect(batch.deletedJobs).toEqual([
            { name: "pk-builder-abcd1234efef5678", namespace: "previewkit-builds", propagationPolicy: "Background" },
        ]);
    });

    it("release silently swallows NotFound (idempotent for crash-recovery loops)", async () => {
        const { kc, batch } = makeKc();
        batch.notFoundOnDelete = true;
        const mgr = new BuildKitJobManager({
            kc,
            namespace: "previewkit-builds",
            image: "moby/buildkit:v0.21.1",
            serviceAccountName: "buildkitd",
            activeDeadlineSeconds: 1860,
            dial: dialAlwaysOk,
        });

        await expect(mgr.release({ name: "pk-builder-deadbeef00000000" })).resolves.toBeUndefined();
    });
});
