import * as k8s from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { Deployer } from "../../src/deployer/deployer";

interface RecordedPatch {
    name: string;
    body: { metadata: { annotations: Record<string, string> }; spec: { replicas: number } };
}

// sleepWorkloads lists the namespace's previewkit-managed Deployments +
// StatefulSets and merge-patches each running one to zero replicas, stamping
// gatekeeper.dev/wake-replicas with the prior count (the exact patch the
// central Gatekeeper's own idle sleep applies, so wake restores the counts).
// We stub AppsV1Api - the only client it touches. The `as unknown as
// k8s.KubeConfig` stub follows the restart-app test pattern.
describe("Deployer.sleepWorkloads", () => {
    function makeDeployer(fakeApps: object): Deployer {
        const fakeKubeConfig = {
            makeApiClient: (cls: unknown) => {
                if (cls === k8s.AppsV1Api) return fakeApps;
                return {};
            },
        } as unknown as k8s.KubeConfig;
        return new Deployer(fakeKubeConfig, "preview.example.com", "secret");
    }

    it("scales running workloads to zero and records their wake replicas", async () => {
        const listedSelectors: string[] = [];
        const deploymentPatches: RecordedPatch[] = [];
        const statefulSetPatches: RecordedPatch[] = [];

        const fakeApps = {
            listNamespacedDeployment: async ({ labelSelector }: { namespace: string; labelSelector?: string }) => {
                if (labelSelector != null) listedSelectors.push(labelSelector);
                return {
                    items: [
                        { metadata: { name: "web" }, spec: { replicas: 2 } },
                        // Already asleep (Gatekeeper idled it earlier): must be skipped,
                        // or its wake-replicas would be overwritten with 0.
                        { metadata: { name: "worker" }, spec: { replicas: 0 } },
                    ],
                };
            },
            listNamespacedStatefulSet: async ({ labelSelector }: { namespace: string; labelSelector?: string }) => {
                if (labelSelector != null) listedSelectors.push(labelSelector);
                // No spec.replicas: the Kubernetes default is 1, never 0.
                return { items: [{ metadata: { name: "postgres" }, spec: {} }] };
            },
            patchNamespacedDeployment: async ({ name, body }: { name: string; body: RecordedPatch["body"] }) => {
                deploymentPatches.push({ name, body });
                return {};
            },
            patchNamespacedStatefulSet: async ({ name, body }: { name: string; body: RecordedPatch["body"] }) => {
                statefulSetPatches.push({ name, body });
                return {};
            },
        };

        const deployer = makeDeployer(fakeApps);
        await deployer.sleepWorkloads("preview-acme-web-pr-7");

        expect(listedSelectors).toEqual([
            "previewkit.dev/managed-by=previewkit",
            "previewkit.dev/managed-by=previewkit",
        ]);
        expect(deploymentPatches).toEqual([
            {
                name: "web",
                body: {
                    metadata: { annotations: { "gatekeeper.dev/wake-replicas": "2" } },
                    spec: { replicas: 0 },
                },
            },
        ]);
        expect(statefulSetPatches).toEqual([
            {
                name: "postgres",
                body: {
                    metadata: { annotations: { "gatekeeper.dev/wake-replicas": "1" } },
                    spec: { replicas: 0 },
                },
            },
        ]);
    });

    it("keeps scaling the remaining workloads when one patch fails", async () => {
        const statefulSetPatches: string[] = [];

        const fakeApps = {
            listNamespacedDeployment: async () => ({
                items: [{ metadata: { name: "web" }, spec: { replicas: 1 } }],
            }),
            listNamespacedStatefulSet: async () => ({
                items: [{ metadata: { name: "postgres" }, spec: { replicas: 1 } }],
            }),
            patchNamespacedDeployment: async () => {
                throw new Error("409 Conflict");
            },
            patchNamespacedStatefulSet: async ({ name }: { name: string }) => {
                statefulSetPatches.push(name);
                return {};
            },
        };

        const deployer = makeDeployer(fakeApps);
        // Never throws for a per-workload failure - fail() is best-effort.
        await deployer.sleepWorkloads("preview-acme-web-pr-7");

        expect(statefulSetPatches).toEqual(["postgres"]);
    });

    it("does nothing in a namespace with no managed workloads", async () => {
        let patched = 0;
        const fakeApps = {
            listNamespacedDeployment: async () => ({ items: [] }),
            listNamespacedStatefulSet: async () => ({ items: [] }),
            patchNamespacedDeployment: async () => {
                patched += 1;
                return {};
            },
            patchNamespacedStatefulSet: async () => {
                patched += 1;
                return {};
            },
        };

        const deployer = makeDeployer(fakeApps);
        await deployer.sleepWorkloads("preview-acme-web-pr-7");

        expect(patched).toBe(0);
    });
});
