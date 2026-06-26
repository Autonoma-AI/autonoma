import * as k8s from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { Deployer } from "../../src/deployer/deployer";

// restartApp deletes the app's pods (so the Deployment controller recreates them
// with fresh config) then waits for readiness. We stub the two k8s clients it
// touches: CoreV1Api (list/delete pods) and AppsV1Api (deployment status). The
// `as unknown as k8s.KubeConfig` stub follows the namespace-manager test pattern.
describe("Deployer.restartApp", () => {
    it("deletes the app's pods and waits for the deployment to become ready", async () => {
        const deletedPods: string[] = [];
        const listedSelectors: string[] = [];

        const fakeCore = {
            listNamespacedPod: async ({ labelSelector }: { namespace: string; labelSelector?: string }) => {
                if (labelSelector != null) listedSelectors.push(labelSelector);
                return { items: [{ metadata: { name: "web-abc" } }, { metadata: { name: "web-def" } }] };
            },
            deleteNamespacedPod: async ({ name }: { namespace: string; name: string }) => {
                deletedPods.push(name);
                return {};
            },
        };
        // Reports a fully rolled-out deployment so the readiness poll returns at once.
        const fakeApps = {
            readNamespacedDeployment: async () => ({
                metadata: { generation: 1 },
                spec: { replicas: 1 },
                status: { observedGeneration: 1, updatedReplicas: 1, availableReplicas: 1 },
            }),
        };
        const fakeKubeConfig = {
            makeApiClient: (cls: unknown) => {
                if (cls === k8s.CoreV1Api) return fakeCore;
                if (cls === k8s.AppsV1Api) return fakeApps;
                return {};
            },
        } as unknown as k8s.KubeConfig;

        const deployer = new Deployer(fakeKubeConfig, "preview.example.com", "secret");
        await deployer.restartApp("preview-acme-web-pr-7", "web");

        expect(deletedPods).toEqual(["web-abc", "web-def"]);
        expect(listedSelectors).toContain("app=web");
    });

    it("throws when pods exist but every deletion fails (no false success)", async () => {
        const fakeCore = {
            listNamespacedPod: async () => ({ items: [{ metadata: { name: "web-abc" } }] }),
            deleteNamespacedPod: async () => {
                throw new Error("403 Forbidden");
            },
        };
        const fakeApps = {
            // An already-healthy deployment would otherwise pass readiness instantly.
            readNamespacedDeployment: async () => ({
                metadata: { generation: 1 },
                spec: { replicas: 1 },
                status: { observedGeneration: 1, updatedReplicas: 1, availableReplicas: 1 },
            }),
        };
        const fakeKubeConfig = {
            makeApiClient: (cls: unknown) => {
                if (cls === k8s.CoreV1Api) return fakeCore;
                if (cls === k8s.AppsV1Api) return fakeApps;
                return {};
            },
        } as unknown as k8s.KubeConfig;

        const deployer = new Deployer(fakeKubeConfig, "preview.example.com", "secret");
        await expect(deployer.restartApp("preview-acme-web-pr-7", "web")).rejects.toThrow(/no pods deleted/);
    });

    it("aborts before deleting any pod when the signal is already fired", async () => {
        const deletedPods: string[] = [];
        const fakeCore = {
            listNamespacedPod: async () => ({ items: [{ metadata: { name: "web-abc" } }] }),
            deleteNamespacedPod: async ({ name }: { namespace: string; name: string }) => {
                deletedPods.push(name);
                return {};
            },
        };
        const fakeKubeConfig = {
            makeApiClient: (cls: unknown) => {
                if (cls === k8s.CoreV1Api) return fakeCore;
                return {};
            },
        } as unknown as k8s.KubeConfig;

        const deployer = new Deployer(fakeKubeConfig, "preview.example.com", "secret");
        await expect(deployer.restartApp("preview-acme-web-pr-7", "web", AbortSignal.abort())).rejects.toThrow();
        expect(deletedPods).toEqual([]);
    });
});
