import { tmpdir } from "node:os";
import type { BuildLogSink, QueueTimeoutSummary } from "@autonoma/logger/build-log-sink";
import type { V1Lease } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
    BuildQueue,
    BuildQueueTimeoutError,
    type QueueLeaseApi,
    type QueuePodsApi,
} from "../../src/builder/build-queue";
import { BuildKitBuilder, TRANSIENT_NETWORK_PATTERNS } from "../../src/builder/buildkit-builder";

/**
 * Minimal lease store for the no-capacity path: tickets are created, renewed,
 * listed, and deleted, but no slot is ever claimable (the pods API below
 * returns an empty pool). No CAS strictness needed - there is no contention.
 */
class TicketOnlyLeaseApi implements QueueLeaseApi {
    private readonly store = new Map<string, V1Lease>();

    async listNamespacedLease(): Promise<{ items: V1Lease[] }> {
        return { items: [...this.store.values()] };
    }

    async createNamespacedLease(params: { namespace: string; body: V1Lease }): Promise<V1Lease> {
        const stored: V1Lease = {
            metadata: { ...params.body.metadata, resourceVersion: "1" },
            spec: params.body.spec,
        };
        this.store.set(params.body.metadata!.name!, stored);
        return stored;
    }

    async replaceNamespacedLease(params: { name: string; namespace: string; body: V1Lease }): Promise<V1Lease> {
        const stored: V1Lease = {
            metadata: { ...params.body.metadata, resourceVersion: "1" },
            spec: params.body.spec,
        };
        this.store.set(params.name, stored);
        return stored;
    }

    async deleteNamespacedLease(params: { name: string }): Promise<unknown> {
        this.store.delete(params.name);
        return {};
    }
}

class EmptyPoolPodsApi implements QueuePodsApi {
    async listNamespacedPod(): Promise<{ items: [] }> {
        return { items: [] };
    }
}

/** Captures telemetry markers; every other sink method is a no-op. */
class CapturingSink implements BuildLogSink {
    readonly queueTimeouts: { environmentId: string; summary: QueueTimeoutSummary }[] = [];

    async append(): Promise<void> {}
    async markStart(): Promise<void> {}
    async markDeploymentStart(): Promise<void> {}
    async markQueueTimeout(environmentId: string, summary: QueueTimeoutSummary): Promise<void> {
        this.queueTimeouts.push({ environmentId, summary });
    }
    async seal(): Promise<void> {}
}

describe("BuildKitBuilder", () => {
    it("emits the queue_timeout telemetry marker when pool admission times out", async () => {
        const queue = new BuildQueue({
            leaseApi: new TicketOnlyLeaseApi(),
            podsApi: new EmptyPoolPodsApi(),
            fallbackAddr: "tcp://buildkit.buildkit.svc.cluster.local:1234",
            slotsPerPod: 2,
            maxWaitMs: 60,
            pollIntervalMs: 10,
        });
        const sink = new CapturingSink();
        const builder = new BuildKitBuilder({
            warmHost: "tcp://buildkit.buildkit.svc.cluster.local:1234",
            buildTimeoutMs: 5_000,
            // The saturation path never touches storage (cache args are only
            // built once a slot is granted), so bucket coordinates suffice.
            storage: { bucket: "test", region: "us-east-1" },
            logSink: sink,
            queue,
        });

        await expect(
            builder.build({
                appName: "web",
                contextPath: tmpdir(),
                buildArgs: {},
                // Non-ECR registry so ensureRepo is a no-op (no AWS calls).
                imageTag: "registry.local:5000/acme/web:abc1234",
                cacheKey: "acme/repo/web",
                namespace: "preview-acme-repo-pr-1",
            }),
        ).rejects.toThrow(BuildQueueTimeoutError);

        expect(sink.queueTimeouts).toHaveLength(1);
        const event = sink.queueTimeouts[0];
        expect(event?.environmentId).toBe("preview-acme-repo-pr-1");
        expect(event?.summary.app).toBe("web");
        expect(event?.summary.queueWaitMs).toBeGreaterThan(60);
    });
});

/** Mirrors the check in BuildKitBuilder.exec: any pattern hit in the combined output tail marks the failure transient. */
function isTransient(outputTail: string): boolean {
    return TRANSIENT_NETWORK_PATTERNS.some((p) => p.test(outputTail));
}

describe("TRANSIENT_NETWORK_PATTERNS", () => {
    it("classifies session-loss errors from a starved pool pod as transient", () => {
        const sessionLossTails = [
            "error: failed to solve: no active session for p8vvbrjdbtxfam6jrbdj8bhbn: context deadline exceeded",
            "rpc error: code = Unknown desc = session healthcheck failed: rpc error: code = DeadlineExceeded desc = context deadline exceeded",
            "error: failed to solve: failed to get session: context deadline exceeded",
        ];
        for (const tail of sessionLossTails) {
            expect(isTransient(tail), tail).toBe(true);
        }
    });

    it("classifies pod-shutdown and connection errors as transient", () => {
        const connectionTails = [
            "buildkitd is shutting down: graceful_stop",
            "error: failed to solve: rpc error: code = Unavailable desc = error reading from server: EOF",
            "dial tcp 10.0.1.7:1234: connect: connection refused",
        ];
        for (const tail of connectionTails) {
            expect(isTransient(tail), tail).toBe(true);
        }
    });

    it("classifies pre-build worker-listing failures against a saturated pool pod as transient", () => {
        // The daemon accepts the TCP connection then drops it before the gRPC
        // handshake (memory-ceilinged pod), so buildctl never lists its workers.
        // A retry re-queues onto a pod with headroom.
        const workerListingTails = [
            'error: listing workers for Build: failed to list workers: Unavailable: connection error: desc = "error reading server preface: read tcp 10.70.72.95:47158->10.70.73.221:1234: use of closed network connection"',
            "failed to list workers: Unavailable: connection error",
        ];
        for (const tail of workerListingTails) {
            expect(isTransient(tail), tail).toBe(true);
        }
    });

    it("does not treat a bare connection string in user build output as transient", () => {
        // The worker-listing signal is anchored on buildctl's own framing, not
        // the bare Go/gRPC connection strings, so a user's RUN step printing
        // "use of closed network connection" is never mislabeled a platform outage.
        expect(isTransient("RUN app log: write tcp: use of closed network connection")).toBe(false);
        expect(isTransient("error reading server preface (from the user's own grpc client)")).toBe(false);
    });

    it("does not classify a bare in-build deadline as transient", () => {
        // Without session/dial wording, "context deadline exceeded" can come from
        // a deterministic in-build timeout that a retry would only replay.
        expect(isTransient("error: failed to solve: process did not complete: context deadline exceeded")).toBe(false);
    });

    it("does not classify an ordinary build failure as transient", () => {
        const buildFailureTail =
            'error: failed to solve: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 1';
        expect(isTransient(buildFailureTail)).toBe(false);
    });
});
