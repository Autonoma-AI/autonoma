import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PreviewFleetClient } from "../../src/preview-liveness/preview-fleet-client";
import type { NamespaceLiveness } from "../../src/preview-liveness/types";
import { EXPECTATIONS, namespacesManifest, workloadsManifest } from "./fixtures";
import { applyManifests, createKindCluster, deleteKindCluster, type KindCluster, kindAvailable } from "./kind-cluster";

const CLUSTER_NAME = "preview-liveness-test";
const POLL_INTERVAL_MS = 3_000;
const STABLE_TIMEOUT_MS = 200_000;

// These tests run the SHIPPED read path (PreviewFleetClient) against a real
// Kubernetes API server so the classifier is validated against actual pod and
// deployment status objects - not a hand-mocked shape the @kubernetes/client-node
// types happen to allow but the API never returns.
describe.skipIf(!kindAvailable())("PreviewFleetClient against a real cluster", () => {
    let cluster: KindCluster;
    let client: PreviewFleetClient;

    beforeAll(async () => {
        cluster = createKindCluster(CLUSTER_NAME);
        applyManifests(cluster, namespacesManifest());
        applyManifests(cluster, workloadsManifest());
        client = new PreviewFleetClient(cluster.kubeConfig);
    });

    afterAll(() => {
        if (cluster != null) deleteKindCluster(cluster);
    });

    it("derives every preview power/health state from real workloads", async () => {
        const fleet = await waitForStableFleet(client);

        for (const expected of EXPECTATIONS) {
            const actual = fleet.get(expected.namespace);

            if (expected.state == null) {
                // The label-filtered LIST must not surface unmanaged workloads.
                expect(actual, `${expected.namespace} should be absent`).toBeUndefined();
                continue;
            }

            expect(actual?.state, `${expected.namespace} power state`).toBe(expected.state);

            if (expected.reasonOneOf != null) {
                const reasons = actual?.workloads.map((w) => w.reason);
                const matched = expected.reasonOneOf.some((r) => reasons?.includes(r));
                expect(matched, `${expected.namespace} error reason in ${JSON.stringify(reasons)}`).toBe(true);
            }
        }

        // The healthy namespace proves both workload kinds classify, and that a
        // namespace rolls up healthy only when every workload is.
        const healthy = fleet.get("preview-healthy");
        expect(healthy?.workloads.map((w) => `${w.kind}:${w.state}`).sort()).toEqual([
            "Deployment:healthy",
            "StatefulSet:healthy",
        ]);
    });
});

// Polls until every namespace reaches its expected (terminal) state, then returns
// that snapshot. Every expected state here is terminal - healthy pods stay
// healthy, a closed-port readiness probe never passes, image-pull/crashloop never
// recover - so the fleet converges and stays put.
async function waitForStableFleet(client: PreviewFleetClient): Promise<Map<string, NamespaceLiveness>> {
    const deadline = Date.now() + STABLE_TIMEOUT_MS;
    let fleet = await client.listFleet();

    while (!allExpectationsMet(fleet) && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        fleet = await client.listFleet();
    }
    return fleet;
}

function allExpectationsMet(fleet: Map<string, NamespaceLiveness>): boolean {
    return EXPECTATIONS.every((expected) => {
        if (expected.state == null) return !fleet.has(expected.namespace);
        return fleet.get(expected.namespace)?.state === expected.state;
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
