import { ApiException, type V1DeleteOptions, type V1Lease, type V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
    BuildQueue,
    type BuildQueueOptions,
    BuildQueueTimeoutError,
    type BuildSlot,
    type QueueLeaseApi,
    type QueuePodsApi,
} from "../../src/builder/build-queue";
import { BuildAbortedError } from "../../src/builder/builder";

const FALLBACK_ADDR = "tcp://buildkit.buildkit.svc.cluster.local:1234";

/**
 * In-memory lease store mimicking the apiserver semantics the queue relies
 * on: create conflicts (409) on an existing name, replace CASes on
 * resourceVersion (409 on mismatch, 404 when absent), delete 404s when absent.
 */
class FakeLeaseApi implements QueueLeaseApi {
    readonly store = new Map<string, V1Lease>();
    /** When true, every method rejects with a non-k8s error (apiserver unreachable). */
    unavailable = false;
    private revision = 0;

    async listNamespacedLease(): Promise<{ items: V1Lease[] }> {
        this.checkAvailable();
        return { items: [...this.store.values()] };
    }

    async createNamespacedLease(params: { namespace: string; body: V1Lease }): Promise<V1Lease> {
        this.checkAvailable();
        const name = params.body.metadata!.name!;
        if (this.store.has(name)) throw new ApiException(409, "conflict", undefined, {});
        const stored: V1Lease = {
            metadata: {
                ...params.body.metadata,
                resourceVersion: String(++this.revision),
                creationTimestamp: new Date(),
            },
            spec: params.body.spec,
        };
        this.store.set(name, stored);
        return stored;
    }

    async replaceNamespacedLease(params: { name: string; namespace: string; body: V1Lease }): Promise<V1Lease> {
        this.checkAvailable();
        const current = this.store.get(params.name);
        if (current == null) throw new ApiException(404, "not found", undefined, {});
        if (params.body.metadata?.resourceVersion !== current.metadata?.resourceVersion) {
            throw new ApiException(409, "conflict", undefined, {});
        }
        const stored: V1Lease = {
            metadata: {
                ...params.body.metadata,
                resourceVersion: String(++this.revision),
                creationTimestamp: current.metadata?.creationTimestamp,
            },
            spec: params.body.spec,
        };
        this.store.set(params.name, stored);
        return stored;
    }

    async deleteNamespacedLease(params: { name: string; namespace: string; body?: V1DeleteOptions }): Promise<unknown> {
        this.checkAvailable();
        const current = this.store.get(params.name);
        if (current == null) throw new ApiException(404, "not found", undefined, {});
        const expected = params.body?.preconditions?.resourceVersion;
        if (expected != null && expected !== current.metadata?.resourceVersion) {
            throw new ApiException(409, "conflict", undefined, {});
        }
        this.store.delete(params.name);
        return {};
    }

    ticketNames(): string[] {
        return [...this.store.keys()].filter((name) => name.startsWith("bkq-t"));
    }

    slotLeases(): V1Lease[] {
        return [...this.store.entries()].filter(([name]) => name.startsWith("bkq-slot-")).map(([, lease]) => lease);
    }

    /** Seeds a slot lease directly (e.g. a crashed holder's leftover). */
    seedSlot(name: string, spec: V1Lease["spec"]): void {
        this.store.set(name, {
            metadata: { name, resourceVersion: String(++this.revision), creationTimestamp: new Date() },
            spec,
        });
    }

    private checkAvailable(): void {
        if (this.unavailable) throw new Error("apiserver unreachable");
    }
}

class FakePodsApi implements QueuePodsApi {
    constructor(public pods: V1Pod[]) {}

    async listNamespacedPod(): Promise<{ items: V1Pod[] }> {
        return { items: this.pods };
    }
}

function makePod(name: string, ip: string, opts?: { ready?: boolean; terminating?: boolean }): V1Pod {
    const metadata: V1Pod["metadata"] = { name, uid: `${name}-uid` };
    if (opts?.terminating === true) metadata.deletionTimestamp = new Date();
    return {
        metadata,
        status: {
            podIP: ip,
            conditions: [{ type: "Ready", status: opts?.ready === false ? "False" : "True" }],
        },
    };
}

interface Harness {
    queue: BuildQueue;
    leaseApi: FakeLeaseApi;
    podsApi: FakePodsApi;
}

function makeHarness(pods: V1Pod[], overrides?: Partial<BuildQueueOptions>): Harness {
    const leaseApi = new FakeLeaseApi();
    const podsApi = new FakePodsApi(pods);
    const queue = new BuildQueue({
        leaseApi,
        podsApi,
        fallbackAddr: FALLBACK_ADDR,
        slotsPerPod: 1,
        maxWaitMs: 3_000,
        pollIntervalMs: 10,
        ...overrides,
    });
    return { queue, leaseApi, podsApi };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tracks whether an acquire has settled without awaiting it. */
function track(promise: Promise<BuildSlot>): { settled: () => boolean; promise: Promise<BuildSlot> } {
    let isSettled = false;
    const tracked = promise.then(
        (slot) => {
            isSettled = true;
            return slot;
        },
        (err: unknown) => {
            isSettled = true;
            throw err;
        },
    );
    return { settled: () => isSettled, promise: tracked };
}

describe("BuildQueue", () => {
    it("grants a free slot immediately and dials the granting pod directly", async () => {
        const { queue, leaseApi } = makeHarness([makePod("bk-a", "10.0.0.1")]);

        const slot = await queue.acquire({ appName: "web", cacheKey: "acme/repo/web" });

        expect(slot.addr).toBe("tcp://10.0.0.1:1234");
        expect(slot.pod).toBe("bk-a");
        // Ticket cleaned up; exactly one slot lease held by this build, owned by the pod.
        expect(leaseApi.ticketNames()).toEqual([]);
        const [lease] = leaseApi.slotLeases();
        expect(lease?.spec?.holderIdentity).toContain("web@");
        expect(lease?.metadata?.ownerReferences?.[0]?.name).toBe("bk-a");
        await slot.release();
        expect(leaseApi.slotLeases()).toEqual([]);
    });

    it("caps concurrency at slotsPerPod x ready pods and admits the next waiter on release", async () => {
        const { queue } = makeHarness([makePod("bk-a", "10.0.0.1")]);

        const first = await queue.acquire({ appName: "web", cacheKey: "k1" });
        const second = track(queue.acquire({ appName: "api", cacheKey: "k2" }));

        await sleep(80);
        expect(second.settled()).toBe(false);

        await first.release();
        const granted = await second.promise;
        expect(granted.pod).toBe("bk-a");
        await granted.release();
    });

    it("admits waiters in FIFO order", async () => {
        const { queue } = makeHarness([makePod("bk-a", "10.0.0.1")]);

        const holder = await queue.acquire({ appName: "hold", cacheKey: "k0" });
        const first = track(queue.acquire({ appName: "first", cacheKey: "k1" }));
        await sleep(5); // ensure a later enqueue-ms for the second ticket
        const second = track(queue.acquire({ appName: "second", cacheKey: "k2" }));
        await sleep(40);

        await holder.release();
        const firstSlot = await first.promise;
        await sleep(60);
        expect(second.settled()).toBe(false);

        await firstSlot.release();
        const secondSlot = await second.promise;
        await secondSlot.release();
    });

    it("reclaims a slot lease whose holder stopped renewing (crashed build)", async () => {
        const { queue, leaseApi } = makeHarness([makePod("bk-a", "10.0.0.1")]);
        leaseApi.seedSlot("bkq-slot-bk-a-0", {
            holderIdentity: "dead@bygone",
            leaseDurationSeconds: 90,
            renewTime: new Date(Date.now() - 200_000),
        });

        const slot = await queue.acquire({ appName: "web", cacheKey: "k1" });

        expect(slot.pod).toBe("bk-a");
        const [lease] = leaseApi.slotLeases();
        expect(lease?.spec?.holderIdentity).toContain("web@");
        await slot.release();
    });

    it("never places builds on terminating or not-ready pods", async () => {
        const { queue } = makeHarness(
            [
                makePod("bk-ready", "10.0.0.1"),
                makePod("bk-terminating", "10.0.0.2", { terminating: true }),
                makePod("bk-booting", "10.0.0.3", { ready: false }),
            ],
            { slotsPerPod: 2 },
        );

        const first = await queue.acquire({ appName: "a", cacheKey: "k1" });
        const second = await queue.acquire({ appName: "b", cacheKey: "k2" });
        expect(first.pod).toBe("bk-ready");
        expect(second.pod).toBe("bk-ready");

        // Both slots of the only eligible pod are busy - a third waiter queues.
        const controller = new AbortController();
        const third = track(queue.acquire({ appName: "c", cacheKey: "k3", signal: controller.signal }));
        await sleep(80);
        expect(third.settled()).toBe(false);

        controller.abort();
        await expect(third.promise).rejects.toThrow(BuildAbortedError);
        await first.release();
        await second.release();
    });

    it("rejects with BuildAbortedError and cleans its ticket when superseded while waiting", async () => {
        const { queue, leaseApi } = makeHarness([makePod("bk-a", "10.0.0.1")]);
        const holder = await queue.acquire({ appName: "hold", cacheKey: "k0" });

        const controller = new AbortController();
        const waiting = queue.acquire({ appName: "web", cacheKey: "k1", signal: controller.signal });
        setTimeout(() => controller.abort(), 30);

        await expect(waiting).rejects.toThrow(BuildAbortedError);
        expect(leaseApi.ticketNames()).toEqual([]);
        await holder.release();
    });

    it("fails the build with a saturation error carrying the waited time after maxWaitMs", async () => {
        // No ready pods at all: zero capacity, the waiter can never be admitted.
        const { queue, leaseApi } = makeHarness([], { maxWaitMs: 80 });

        const err = await queue.acquire({ appName: "web", cacheKey: "k1" }).then(
            () => undefined,
            (rejection: unknown) => rejection,
        );

        expect(err).toBeInstanceOf(BuildQueueTimeoutError);
        if (!(err instanceof BuildQueueTimeoutError)) throw new Error("unreachable");
        expect(err.waitedMs).toBeGreaterThan(80);
        expect(leaseApi.ticketNames()).toEqual([]);
    });

    it("fails open to the shared Service endpoint when the queue infrastructure is unavailable", async () => {
        const { queue, leaseApi } = makeHarness([makePod("bk-a", "10.0.0.1")]);
        leaseApi.unavailable = true;

        const messages: string[] = [];
        const slot = await queue.acquire({ appName: "web", cacheKey: "k1", onWait: (m) => messages.push(m) });

        expect(slot.addr).toBe(FALLBACK_ADDR);
        expect(slot.pod).toBeUndefined();
        expect(messages.some((m) => m.includes("without admission control"))).toBe(true);
        await slot.release();
    });

    it("keeps the slot lease renewed while the build runs", async () => {
        const { queue, leaseApi } = makeHarness([makePod("bk-a", "10.0.0.1")], { slotRenewMs: 20 });

        const slot = await queue.acquire({ appName: "web", cacheKey: "k1" });
        const before = leaseApi.slotLeases()[0]?.spec?.renewTime?.getTime();
        await sleep(70);
        const after = leaseApi.slotLeases()[0]?.spec?.renewTime?.getTime();

        expect(before).toBeDefined();
        expect(after).toBeDefined();
        expect(after!).toBeGreaterThan(before!);
        await slot.release();
        expect(leaseApi.slotLeases()).toEqual([]);
    });

    it("prefers the same pod for the same cache key (warm-cache affinity)", async () => {
        const pods = [makePod("bk-a", "10.0.0.1"), makePod("bk-b", "10.0.0.2")];
        const { queue } = makeHarness(pods);

        const first = await queue.acquire({ appName: "web", cacheKey: "acme/repo/web" });
        const chosen = first.pod;
        await first.release();

        const second = await queue.acquire({ appName: "web", cacheKey: "acme/repo/web" });
        expect(second.pod).toBe(chosen);
        await second.release();
    });

    it("ignores and garbage-collects stale tickets from crashed waiters", async () => {
        const { queue, leaseApi } = makeHarness([makePod("bk-a", "10.0.0.1")]);
        // An ancient ticket (lexicographically first = front of the line) whose
        // waiter died long ago must not block the live waiter behind it.
        leaseApi.store.set("bkq-t0000000000000-dead00", {
            metadata: { name: "bkq-t0000000000000-dead00", resourceVersion: "1" },
            spec: { holderIdentity: "dead@bygone", renewTime: new Date(Date.now() - 200_000) },
        });

        const slot = await queue.acquire({ appName: "web", cacheKey: "k1" });
        expect(slot.pod).toBe("bk-a");
        await sleep(20); // let the fire-and-forget GC land
        expect(leaseApi.store.has("bkq-t0000000000000-dead00")).toBe(false);
        await slot.release();
    });

    it("reports queue position while waiting", async () => {
        const { queue } = makeHarness([makePod("bk-a", "10.0.0.1")]);
        const holder = await queue.acquire({ appName: "hold", cacheKey: "k0" });

        const messages: string[] = [];
        const controller = new AbortController();
        const waiting = queue.acquire({
            appName: "web",
            cacheKey: "k1",
            signal: controller.signal,
            onWait: (m) => messages.push(m),
        });
        await sleep(60);
        controller.abort();
        await expect(waiting).rejects.toThrow(BuildAbortedError);

        expect(messages.some((m) => m.includes("position 1") && m.includes("1/1 slots busy"))).toBe(true);
        await holder.release();
    });
});
