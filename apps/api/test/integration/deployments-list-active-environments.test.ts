import { type PreviewkitAppStatus } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

apiTestSuite({
    name: "deployments.listActiveEnvironments",
    cases: (test) => {
        test("returns every configured app with its status, including apps that have no URL", async ({ harness }) => {
            const environment = await createActiveEnvironment(harness, {
                prNumber: 901,
                urls: { web: "https://web-pr901.preview.example.com" },
                appInstances: [
                    { appName: "web", status: "ready", url: "https://web-pr901.preview.example.com" },
                    { appName: "api", status: "building" },
                    { appName: "worker", status: "build_failed", error: "compile error" },
                ],
            });

            const environments = await harness.services.deployments.listActiveEnvironments();
            const found = environments.find((candidate) => candidate.id === environment.id);

            expect(found).toBeDefined();
            // Sorted by app name; apps without a URL are still present with their status.
            expect(found!.apps).toEqual([
                { appName: "api", status: "building", url: undefined, error: undefined },
                { appName: "web", status: "ready", url: "https://web-pr901.preview.example.com", error: undefined },
                { appName: "worker", status: "build_failed", url: undefined, error: "compile error" },
            ]);
        });

        test("reports health ready when every app is ready even though the env status is failed", async ({
            harness,
        }) => {
            // The reported inconsistency: a fully-deployed environment whose
            // post-deploy GitHub finalization failed is stamped `failed`, yet every
            // app is `ready`. The headline health must reconcile to `ready`.
            const environment = await createActiveEnvironment(harness, {
                prNumber: 904,
                status: "failed",
                urls: { web: "https://web-pr904.preview.example.com" },
                appInstances: [
                    { appName: "web", status: "ready", url: "https://web-pr904.preview.example.com" },
                    { appName: "api", status: "ready", url: "https://api-pr904.preview.example.com" },
                ],
            });

            const environments = await harness.services.deployments.listActiveEnvironments();
            const found = environments.find((candidate) => candidate.id === environment.id);

            expect(found!.status).toBe("failed"); // raw pipeline state preserved
            expect(found!.health).toBe("ready"); // reconciled headline
            expect(found!.apps.every((app) => app.status === "ready")).toBe(true);
        });

        test("excludes torn-down environments", async ({ harness }) => {
            const environment = await createActiveEnvironment(harness, {
                prNumber: 902,
                status: "torn_down",
                urls: {},
                appInstances: [{ appName: "web", status: "ready" }],
            });

            const environments = await harness.services.deployments.listActiveEnvironments();
            expect(environments.find((candidate) => candidate.id === environment.id)).toBeUndefined();
        });

        test("surfaces a legacy url-only app that has no app-instance row as ready", async ({ harness }) => {
            const environment = await createActiveEnvironment(harness, {
                prNumber: 903,
                urls: { legacy: "https://legacy-pr903.preview.example.com" },
                appInstances: [],
            });

            const environments = await harness.services.deployments.listActiveEnvironments();
            const found = environments.find((candidate) => candidate.id === environment.id);

            expect(found!.apps).toEqual([
                {
                    appName: "legacy",
                    status: "ready",
                    url: "https://legacy-pr903.preview.example.com",
                    error: undefined,
                },
            ]);
        });
    },
});

async function createActiveEnvironment(
    harness: APITestHarness,
    input: {
        prNumber: number;
        status?: "pending" | "building" | "deploying" | "ready" | "failed" | "torn_down";
        urls: Record<string, string>;
        appInstances: Array<{ appName: string; status: PreviewkitAppStatus; url?: string; error?: string }>;
    },
) {
    const environment = await harness.db.previewkitEnvironment.create({
        data: {
            namespace: `preview-active-pr-${input.prNumber}`,
            repoFullName: `Autonoma-AI/preview-active-${input.prNumber}`,
            prNumber: input.prNumber,
            headSha: "sha-active",
            headRef: `feat/active-${input.prNumber}`,
            organizationId: harness.organizationId,
            status: input.status ?? "ready",
            urls: input.urls,
        },
    });

    for (const app of input.appInstances) {
        await harness.db.previewkitAppInstance.create({
            data: {
                environmentId: environment.id,
                appName: app.appName,
                status: app.status,
                url: app.url,
                error: app.error,
                port: 3000,
            },
        });
    }

    return environment;
}
