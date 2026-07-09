import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "@autonoma/logger";
import {
    ApiException,
    type V1DeleteOptions,
    type V1Lease,
    V1MicroTime,
    type V1ObjectMeta,
    type V1Pod,
} from "@kubernetes/client-node";
import { logger as rootLogger } from "../logger";
import { BuildAbortedError, BuildError } from "./builder";

// The warm buildkitd pool's home. Slot + ticket leases live next to the pods
// they gate so `kubectl -n buildkit get leases` shows the whole queue state.
const QUEUE_NAMESPACE = "buildkit";
const POOL_POD_SELECTOR = "app=buildkit";
const BUILDKIT_PORT = 1234;

// All queue leases carry these labels; the label selector keeps the list call
// server-side filtered to queue objects (the namespace also holds unrelated
// leases, e.g. controller leader elections).
const QUEUE_LABELS = { "previewkit.dev/managed-by": "previewkit", "previewkit.dev/type": "build-queue" };
const QUEUE_LABEL_SELECTOR = "previewkit.dev/type=build-queue";

// Lease name prefixes. Ticket names embed the enqueue epoch-ms so plain
// lexicographic name order IS the FIFO order (13-digit ms keeps the sort
// stable until the year 2286).
const TICKET_PREFIX = "bkq-t";
const SLOT_PREFIX = "bkq-slot-";

// Crash-safety horizons. A slot holder renews its lease every SLOT_RENEW_MS;
// a waiter renews its ticket on every poll. Anything not renewed within its
// horizon is treated as abandoned (holder pod crashed / was OOM-killed) and
// reclaimed. 3x headroom over the renew cadence tolerates apiserver blips.
const SLOT_LEASE_DURATION_S = 90;
const DEFAULT_SLOT_RENEW_MS = 30_000;
const DEFAULT_TICKET_STALE_MS = 90_000;

// Emit a human-readable "still waiting" line (build log + logger) this often.
const WAIT_LOG_EVERY_MS = 15_000;

// Consecutive poll failures tolerated before failing open. One apiserver blip
// must not bypass admission control, but a persistently unreachable queue
// (missing RBAC, apiserver outage) must never block builds either.
const INFRA_ERROR_STREAK_LIMIT = 3;

/**
 * The slice of `CoordinationV1Api` the queue uses. `CoordinationV1Api`
 * satisfies it structurally (same seam pattern as the API's `PreviewJobsApi`),
 * so tests inject an in-memory fake instead of faking a real client.
 */
export interface QueueLeaseApi {
    listNamespacedLease(params: { namespace: string; labelSelector?: string }): Promise<{ items: V1Lease[] }>;
    createNamespacedLease(params: { namespace: string; body: V1Lease }): Promise<V1Lease>;
    replaceNamespacedLease(params: { name: string; namespace: string; body: V1Lease }): Promise<V1Lease>;
    deleteNamespacedLease(params: { name: string; namespace: string; body?: V1DeleteOptions }): Promise<unknown>;
}

/** The slice of `CoreV1Api` used to enumerate the warm pool's ready pods. */
export interface QueuePodsApi {
    listNamespacedPod(params: { namespace: string; labelSelector?: string }): Promise<{ items: V1Pod[] }>;
}

/** A granted admission: the concrete buildkitd endpoint to dial, and the handle to free it. */
export interface BuildSlot {
    /** buildkitd endpoint for this build (`tcp://<podIP>:1234`), or the shared Service host on fail-open. */
    addr: string;
    /** Pool pod that granted the slot; undefined on the fail-open fallback. */
    pod?: string;
    /** Milliseconds spent queued before admission. */
    waitMs: number;
    /** Frees the slot for the next waiter. Never throws. */
    release(): Promise<void>;
}

export interface AcquireBuildSlotRequest {
    appName: string;
    /** Build cache key - drives best-effort pod affinity (rendezvous hashing). */
    cacheKey: string;
    /** Supersede/cancel signal; aborting rejects the acquire with {@link BuildAbortedError}. */
    signal?: AbortSignal;
    /** Receives human-readable wait/grant lines for the customer-facing build log. */
    onWait?: (message: string) => void;
}

/** Waited longer than `maxWaitMs` for admission - the pool is saturated beyond what autoscaling absorbed. */
export class BuildQueueTimeoutError extends BuildError {
    /** How long this build waited for admission before giving up. Carried so
     *  the builder can report the wait in the saturation telemetry marker -
     *  the acquire never returned a slot, so the wait is otherwise lost. */
    readonly waitedMs: number;

    constructor(message: string, waitedMs: number) {
        super(message);
        this.name = "BuildQueueTimeoutError";
        this.waitedMs = waitedMs;
    }
}

export interface BuildQueueOptions {
    leaseApi: QueueLeaseApi;
    podsApi: QueuePodsApi;
    /** Shared pool Service endpoint used when the queue itself is unavailable (fail-open). */
    fallbackAddr: string;
    /** Concurrent builds admitted per ready buildkitd pod. Pairs with the pod's `max-parallelism` and the KEDA threshold. */
    slotsPerPod: number;
    /** Give up waiting after this long and fail the build with a clear saturation error. */
    maxWaitMs: number;
    pollIntervalMs: number;
    /** Test-only overrides for the renew/staleness cadences. */
    slotRenewMs?: number;
    ticketStaleMs?: number;
}

interface PoolPod {
    name: string;
    uid: string;
    ip: string;
}

interface PoolState {
    readyPods: PoolPod[];
    /** FIFO-ordered fresh tickets (lexicographic name order = enqueue order). */
    tickets: V1Lease[];
    slotsByName: Map<string, V1Lease>;
}

interface FreeSlot {
    pod: PoolPod;
    index: number;
    /** The expired lease occupying the slot, when one exists (claim via CAS replace instead of create). */
    existing?: V1Lease;
}

/**
 * Global admission queue for the warm buildkit pool, shared by every runner
 * Job across every environment (prod / beta / alpha runners all execute in the
 * control cluster but write to different databases - the Kubernetes API is the
 * one medium they already share).
 *
 * Two kinds of `coordination.k8s.io` Leases in the `buildkit` namespace:
 *
 *  - **Tickets** (`bkq-t<enqueueMs>-<rand>`): one per waiting build, renewed on
 *    every poll. Name order is the FIFO order; only the oldest N waiters may
 *    claim the N free slots, so a saturated pool drains fairly instead of by
 *    polling luck.
 *  - **Slots** (`bkq-slot-<pod>-<i>`): `slotsPerPod` per READY pool pod. A
 *    claim CASes the lease (create, or resourceVersion replace of an expired
 *    one) and the build then dials THAT pod's IP directly - a hard per-daemon
 *    concurrency bound, unlike the Service's random routing which can pile
 *    every build onto one pod. Slot leases carry an ownerReference to their
 *    pod, so Kubernetes garbage-collects them when the pod goes away.
 *
 * Capacity follows the pool automatically: a KEDA scale-up's new pod becomes
 * claimable the moment it is Ready, and a terminating pod stops receiving new
 * builds immediately. Free-slot preference is rendezvous-hashed on the build's
 * cacheKey, so repeat builds of the same app land on the pod whose NVMe cache
 * is already warm whenever it has a free slot (best-effort affinity).
 *
 * Crash-safe: holders heartbeat their slot lease; a crashed holder's lease
 * expires and is reclaimed. Fail-open: if the queue infrastructure itself is
 * unavailable (RBAC missing, apiserver down) for several consecutive polls,
 * the build proceeds against the shared Service endpoint with a loud warning -
 * the queue can never brick all builds.
 */
export class BuildQueue {
    private readonly leaseApi: QueueLeaseApi;
    private readonly podsApi: QueuePodsApi;
    private readonly fallbackAddr: string;
    private readonly slotsPerPod: number;
    private readonly maxWaitMs: number;
    private readonly pollIntervalMs: number;
    private readonly slotRenewMs: number;
    private readonly ticketStaleMs: number;
    /** Distinguishes this runner process in lease holder identities. */
    private readonly instanceId: string;
    private readonly logger: Logger;

    constructor(options: BuildQueueOptions) {
        this.leaseApi = options.leaseApi;
        this.podsApi = options.podsApi;
        this.fallbackAddr = options.fallbackAddr;
        this.slotsPerPod = options.slotsPerPod;
        this.maxWaitMs = options.maxWaitMs;
        this.pollIntervalMs = options.pollIntervalMs;
        this.slotRenewMs = options.slotRenewMs ?? DEFAULT_SLOT_RENEW_MS;
        this.ticketStaleMs = options.ticketStaleMs ?? DEFAULT_TICKET_STALE_MS;
        this.instanceId = randomUUID().slice(0, 8);
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Waits for a free build slot and returns it. Resolves with a fallback
     * slot (shared Service endpoint, no-op release) when the queue itself is
     * unavailable. Rejects with {@link BuildAbortedError} when the signal
     * fires and {@link BuildQueueTimeoutError} after `maxWaitMs`.
     */
    async acquire(request: AcquireBuildSlotRequest): Promise<BuildSlot> {
        const startedAt = Date.now();
        const ticketName = `${TICKET_PREFIX}${startedAt}-${randomUUID().slice(0, 6)}`;
        const holder = `${request.appName}@${this.instanceId}`;
        this.logger.info("Waiting for a buildkit build slot", {
            extra: { app: request.appName, cacheKey: request.cacheKey, ticketName },
        });

        let ticket: V1Lease | undefined;
        let errorStreak = 0;
        let lastWaitLogAt = 0;
        try {
            while (true) {
                if (request.signal?.aborted === true) {
                    throw new BuildAbortedError("build aborted while waiting for a build slot (cancelled)");
                }
                const waitedMs = Date.now() - startedAt;
                if (waitedMs > this.maxWaitMs) {
                    throw new BuildQueueTimeoutError(
                        `Timed out waiting for a buildkit build slot after ${formatSeconds(waitedMs)} - ` +
                            `the build pool is saturated. The autoscaler may still be adding capacity; ` +
                            `retry the deploy shortly.`,
                        waitedMs,
                    );
                }

                try {
                    ticket = await this.upsertTicket(ticketName, holder, ticket);
                    const state = await this.readPoolState(ticketName);
                    const slot = await this.tryAdmit(ticketName, holder, request.cacheKey, state, startedAt);
                    if (slot != null) {
                        this.logger.info("Acquired buildkit build slot", {
                            extra: { app: request.appName, pod: slot.pod, waitMs: slot.waitMs },
                        });
                        if (slot.waitMs >= this.pollIntervalMs) {
                            request.onWait?.(
                                `Build slot acquired on ${slot.pod ?? "pool"} after ${formatSeconds(slot.waitMs)}`,
                            );
                        }
                        return slot;
                    }
                    errorStreak = 0;
                    if (Date.now() - lastWaitLogAt >= WAIT_LOG_EVERY_MS) {
                        lastWaitLogAt = Date.now();
                        this.reportWaiting(request, ticketName, state, waitedMs);
                    }
                } catch (err) {
                    // Our own verdicts (abort, timeout) pass through; everything
                    // else is queue infrastructure failing, which must never
                    // block builds for long - fail open after a short streak.
                    if (err instanceof BuildError) throw err;
                    errorStreak += 1;
                    this.logger.warn("Build queue poll failed", {
                        extra: { app: request.appName, errorStreak, err },
                    });
                    if (errorStreak >= INFRA_ERROR_STREAK_LIMIT) {
                        return this.failOpen(request, startedAt, err);
                    }
                }

                await sleepWithJitter(this.pollIntervalMs, request.signal);
            }
        } finally {
            await this.deleteTicket(ticketName);
        }
    }

    /**
     * Creates the ticket on the first poll, then keeps its `renewTime` fresh so
     * peers never garbage-collect it. Recreates it (same name, so the FIFO
     * position is kept) if a peer GC'd it while this process was stalled.
     */
    private async upsertTicket(name: string, holder: string, current: V1Lease | undefined): Promise<V1Lease> {
        const body: V1Lease = {
            metadata: this.leaseMetadata(name, current?.metadata?.resourceVersion),
            spec: { holderIdentity: holder, renewTime: new V1MicroTime() },
        };
        try {
            if (current == null) {
                return await this.leaseApi.createNamespacedLease({ namespace: QUEUE_NAMESPACE, body });
            }
            return await this.leaseApi.replaceNamespacedLease({ name, namespace: QUEUE_NAMESPACE, body });
        } catch (err) {
            // 404: a peer GC'd our ticket (we stalled past the staleness
            // horizon); 409 on create: leftover ticket from a crashed poll.
            // Both resolve on the next upsert via a fresh read cycle.
            if (isApiCode(err, 404)) {
                this.logger.warn("Build queue ticket disappeared; recreating with the same FIFO position", {
                    extra: { ticketName: name },
                });
                const recreated: V1Lease = { metadata: this.leaseMetadata(name), spec: body.spec };
                return await this.leaseApi.createNamespacedLease({ namespace: QUEUE_NAMESPACE, body: recreated });
            }
            throw err;
        }
    }

    /** Lists ready pool pods and queue leases, and GCs stale tickets from crashed waiters. */
    private async readPoolState(ownTicketName: string): Promise<PoolState> {
        const [pods, leases] = await Promise.all([
            this.podsApi.listNamespacedPod({ namespace: QUEUE_NAMESPACE, labelSelector: POOL_POD_SELECTOR }),
            this.leaseApi.listNamespacedLease({ namespace: QUEUE_NAMESPACE, labelSelector: QUEUE_LABEL_SELECTOR }),
        ]);

        const readyPods: PoolPod[] = [];
        for (const pod of pods.items) {
            if (!isReadyPod(pod)) continue;
            readyPods.push({ name: pod.metadata!.name!, uid: pod.metadata!.uid!, ip: pod.status!.podIP! });
        }

        const tickets: V1Lease[] = [];
        const slotsByName = new Map<string, V1Lease>();
        for (const lease of leases.items) {
            const name = lease.metadata?.name;
            if (name == null) continue;
            if (name.startsWith(SLOT_PREFIX)) {
                slotsByName.set(name, lease);
                continue;
            }
            if (!name.startsWith(TICKET_PREFIX)) continue;
            // Own ticket always counts (its freshness is ours to maintain);
            // stale peers are dropped from the line and deleted best-effort.
            if (name === ownTicketName || this.isFreshTicket(lease)) {
                tickets.push(lease);
                continue;
            }
            void this.leaseApi.deleteNamespacedLease({ name, namespace: QUEUE_NAMESPACE }).catch((err: unknown) => {
                this.logger.debug("Failed to GC stale build queue ticket (another waiter likely did)", {
                    extra: { ticketName: name, err },
                });
            });
        }
        tickets.sort((a, b) => (a.metadata!.name! < b.metadata!.name! ? -1 : 1));

        return { readyPods, tickets, slotsByName };
    }

    /**
     * FIFO admission: this waiter may claim a slot only when its queue rank is
     * within the number of currently free slots. Free slots are tried in
     * rendezvous-hash order of the build's cacheKey (cache affinity); a CAS
     * conflict just means another waiter won that slot - try the next.
     */
    private async tryAdmit(
        ticketName: string,
        holder: string,
        cacheKey: string,
        state: PoolState,
        startedAt: number,
    ): Promise<BuildSlot | undefined> {
        const rank = state.tickets.findIndex((t) => t.metadata?.name === ticketName);
        if (rank === -1) return undefined;

        const free = this.findFreeSlots(state);
        if (rank >= free.length) return undefined;

        free.sort((a, b) => {
            const byPod = rendezvousScore(b.pod.name, cacheKey).localeCompare(rendezvousScore(a.pod.name, cacheKey));
            return byPod !== 0 ? byPod : a.index - b.index;
        });

        for (const candidate of free) {
            const lease = await this.claimSlot(candidate, holder);
            if (lease != null) {
                return this.grantSlot(candidate.pod, lease, Date.now() - startedAt);
            }
        }
        return undefined;
    }

    private findFreeSlots(state: PoolState): FreeSlot[] {
        const free: FreeSlot[] = [];
        for (const pod of state.readyPods) {
            for (let index = 0; index < this.slotsPerPod; index++) {
                const existing = state.slotsByName.get(slotName(pod.name, index));
                if (existing == null) {
                    free.push({ pod, index });
                    continue;
                }
                if (isExpiredSlot(existing)) {
                    free.push({ pod, index, existing });
                }
            }
        }
        return free;
    }

    /**
     * CAS-claims one slot: create when absent, resourceVersion-guarded replace
     * when reclaiming an expired holder's lease. Returns undefined when a
     * concurrent waiter won the race (409) or the lease vanished (404).
     */
    private async claimSlot(candidate: FreeSlot, holder: string): Promise<V1Lease | undefined> {
        const name = slotName(candidate.pod.name, candidate.index);
        const metadata = this.leaseMetadata(name, candidate.existing?.metadata?.resourceVersion);
        // The pod owns its slot leases: when the pod is deleted (scale-down,
        // crash), Kubernetes garbage-collects them, so nothing accumulates.
        metadata.ownerReferences = [
            { apiVersion: "v1", kind: "Pod", name: candidate.pod.name, uid: candidate.pod.uid },
        ];
        const body: V1Lease = {
            metadata,
            spec: {
                holderIdentity: holder,
                leaseDurationSeconds: SLOT_LEASE_DURATION_S,
                acquireTime: new V1MicroTime(),
                renewTime: new V1MicroTime(),
            },
        };
        try {
            if (candidate.existing == null) {
                return await this.leaseApi.createNamespacedLease({ namespace: QUEUE_NAMESPACE, body });
            }
            return await this.leaseApi.replaceNamespacedLease({ name, namespace: QUEUE_NAMESPACE, body });
        } catch (err) {
            if (isApiCode(err, 409) || isApiCode(err, 404)) return undefined;
            throw err;
        }
    }

    /** Wraps a claimed lease into the caller-facing slot, with a heartbeat keeping the lease fresh for the build's duration. */
    private grantSlot(pod: PoolPod, lease: V1Lease, waitMs: number): BuildSlot {
        const name = lease.metadata!.name!;
        let current = lease;
        // Set when the lease stops being ours (reclaimed after a stall past the
        // expiry horizon): release() must then leave it alone - deleting it
        // would free a slot another build is actively using.
        let lost = false;
        const heartbeat = setInterval(() => {
            const body: V1Lease = {
                metadata: this.leaseMetadata(name, current.metadata?.resourceVersion),
                spec: { ...current.spec, renewTime: new V1MicroTime() },
            };
            body.metadata!.ownerReferences = current.metadata?.ownerReferences;
            this.leaseApi
                .replaceNamespacedLease({ name, namespace: QUEUE_NAMESPACE, body })
                .then((updated) => {
                    current = updated;
                })
                .catch((err: unknown) => {
                    // Never fail a running build over a heartbeat: worst case the
                    // lease expires and the pod briefly serves one extra build.
                    // 409/404 means the lease was reclaimed (we stalled past the
                    // horizon) - it is not ours anymore, so stop renewing rather
                    // than warn every interval for the rest of the build.
                    if (isApiCode(err, 409) || isApiCode(err, 404)) {
                        lost = true;
                        clearInterval(heartbeat);
                        this.logger.warn("Build slot lease was reclaimed mid-build; continuing unqueued", {
                            extra: { slot: name },
                        });
                        return;
                    }
                    this.logger.warn("Failed to renew build slot lease", { extra: { slot: name, err } });
                });
        }, this.slotRenewMs);

        return {
            addr: `tcp://${pod.ip}:${BUILDKIT_PORT}`,
            pod: pod.name,
            waitMs,
            release: async () => {
                clearInterval(heartbeat);
                if (lost) return;
                try {
                    // resourceVersion-preconditioned: only deletes the lease we
                    // still own; a concurrent reclaimer's lease survives (409).
                    const body: V1DeleteOptions = {
                        preconditions: { resourceVersion: current.metadata?.resourceVersion },
                    };
                    await this.leaseApi.deleteNamespacedLease({ name, namespace: QUEUE_NAMESPACE, body });
                    this.logger.info("Released buildkit build slot", { extra: { slot: name } });
                } catch (err) {
                    if (isApiCode(err, 404) || isApiCode(err, 409)) return;
                    // The lease expires on its own within the lease duration.
                    this.logger.warn("Failed to release build slot lease; it will expire on its own", {
                        extra: { slot: name, err },
                    });
                }
            },
        };
    }

    /** The queue infrastructure is unavailable - proceed unqueued via the shared Service endpoint, loudly. */
    private failOpen(request: AcquireBuildSlotRequest, startedAt: number, cause: unknown): BuildSlot {
        const waitMs = Date.now() - startedAt;
        this.logger.error("Build queue unavailable; failing open to the shared pool endpoint", cause, {
            extra: { app: request.appName, waitMs },
        });
        request.onWait?.("Build queue unavailable - proceeding without admission control");
        return {
            addr: this.fallbackAddr,
            waitMs,
            release: async () => {},
        };
    }

    private reportWaiting(
        request: AcquireBuildSlotRequest,
        ticketName: string,
        state: PoolState,
        waitedMs: number,
    ): void {
        const rank = state.tickets.findIndex((t) => t.metadata?.name === ticketName);
        const totalSlots = state.readyPods.length * this.slotsPerPod;
        const busySlots = totalSlots - this.findFreeSlots(state).length;
        const message =
            `Waiting for a free buildkit build slot ` +
            `(position ${rank + 1} of ${state.tickets.length} queued, ${busySlots}/${totalSlots} slots busy, ` +
            `waited ${formatSeconds(waitedMs)})`;
        this.logger.info(message, {
            extra: { app: request.appName, rank: rank + 1, queued: state.tickets.length, busySlots, totalSlots },
        });
        request.onWait?.(message);
    }

    private async deleteTicket(name: string): Promise<void> {
        try {
            await this.leaseApi.deleteNamespacedLease({ name, namespace: QUEUE_NAMESPACE });
        } catch (err) {
            if (isApiCode(err, 404)) return;
            // Peers ignore + GC stale tickets, so a leaked one only lingers briefly.
            this.logger.warn("Failed to delete build queue ticket; peers will GC it", {
                extra: { ticketName: name, err },
            });
        }
    }

    private leaseMetadata(name: string, resourceVersion?: string): V1ObjectMeta {
        const metadata: V1ObjectMeta = { name, namespace: QUEUE_NAMESPACE, labels: { ...QUEUE_LABELS } };
        if (resourceVersion != null) metadata.resourceVersion = resourceVersion;
        return metadata;
    }

    private isFreshTicket(lease: V1Lease): boolean {
        const renewedAt = lease.spec?.renewTime ?? lease.metadata?.creationTimestamp;
        if (renewedAt == null) return false;
        return Date.now() - renewedAt.getTime() <= this.ticketStaleMs;
    }
}

function slotName(podName: string, index: number): string {
    return `${SLOT_PREFIX}${podName}-${index}`;
}

/** Ready, routable, and not terminating - the pods new builds may be placed on. */
function isReadyPod(pod: V1Pod): boolean {
    if (pod.metadata?.name == null || pod.metadata.uid == null) return false;
    if (pod.metadata.deletionTimestamp != null) return false;
    if (pod.status?.podIP == null) return false;
    const conditions = pod.status.conditions ?? [];
    return conditions.some((c) => c.type === "Ready" && c.status === "True");
}

/** A slot lease whose holder stopped renewing (crashed/OOM-killed runner) is reclaimable. */
function isExpiredSlot(lease: V1Lease): boolean {
    const holder = lease.spec?.holderIdentity;
    if (holder == null || holder === "") return true;
    const renewedAt = lease.spec?.renewTime ?? lease.spec?.acquireTime;
    if (renewedAt == null) return true;
    const durationMs = (lease.spec?.leaseDurationSeconds ?? SLOT_LEASE_DURATION_S) * 1000;
    return Date.now() - renewedAt.getTime() > durationMs;
}

/**
 * Rendezvous (highest-random-weight) score of a pool pod for a cache key.
 * Ordering free slots by it makes repeat builds of the same app prefer the
 * same pod - whose NVMe layer cache is already warm - while spilling to any
 * other free pod under contention, with no state to maintain.
 */
function rendezvousScore(podName: string, cacheKey: string): string {
    return createHash("sha1").update(`${podName}:${cacheKey}`).digest("hex");
}

function isApiCode(err: unknown, code: number): boolean {
    return err instanceof ApiException && err.code === code;
}

function formatSeconds(ms: number): string {
    return `${Math.round(ms / 1000)}s`;
}

/** Signal-aware sleep with jitter (de-syncs waiters polling in lockstep); resolves early on abort. */
function sleepWithJitter(baseMs: number, signal?: AbortSignal): Promise<void> {
    // An already-fired signal never invokes late-added listeners; bail now so
    // an abort during the preceding API calls is honored without a full sleep.
    if (signal?.aborted === true) return Promise.resolve();
    const ms = baseMs + Math.floor(Math.random() * baseMs * 0.4);
    return new Promise<void>((resolve) => {
        const done = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
    });
}
