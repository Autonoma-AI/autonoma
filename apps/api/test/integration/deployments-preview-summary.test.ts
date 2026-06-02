import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

apiTestSuite({
    name: "deployments.previewSummaryByPr",
    cases: (test) => {
        test("returns a ready preview summary with persisted service rows", async ({ harness }) => {
            const fixture = await createPreviewFixture(harness, { prNumber: 201, lastHandledSha: "sha-ready" });

            await createPreviewEnvironment(harness, fixture, {
                status: "ready",
                manifest: {
                    apps: [{ name: "web", port: 3000, primary: true }],
                    services: [{ name: "postgres", recipe: "postgres", version: "16" }],
                    addons: [{ name: "db", provider: "neon" }],
                },
                urls: { web: "https://web-pr201.preview.example.com" },
                appBuilds: {
                    web: {
                        status: "ok",
                        imageTag: "web:sha-ready",
                        durationMs: 1000,
                        logUrl: "https://logs.example.com/web",
                    },
                },
                appInstances: [
                    {
                        appName: "web",
                        imageTag: "web:sha-ready",
                        url: "https://web-pr201.preview.example.com",
                        port: 3000,
                    },
                ],
                addons: [{ name: "db", provider: "neon", status: "ok", outputs: { host: "db.preview.example.com" } }],
            });

            const summary = await harness.request().deployments.previewSummaryByPr({
                applicationId: fixture.application.id,
                prNumber: fixture.prNumber,
            });

            expect(summary.status).toBe("ready");
            expect(summary.primaryUrl).toBe("https://web-pr201.preview.example.com");
            expect(summary.serviceCount).toBe(3);
            expect(summary.readyServiceCount).toBe(3);
            expect(summary.services.map((service) => service.name).sort()).toEqual(["db", "postgres", "web"]);
            expect(
                summary.services
                    .map((service) => ({ name: service.name, iconKey: service.iconKey }))
                    .sort((left, right) => left.name.localeCompare(right.name)),
            ).toEqual([
                { name: "db", iconKey: "postgres" },
                { name: "postgres", iconKey: "postgres" },
                { name: "web", iconKey: "web" },
            ]);
            expect(summary.actions.openPreview.enabled).toBe(true);
        });

        test("returns icon keys for Previewkit apps, recipes, addons, and fallbacks", async ({ harness }) => {
            const fixture = await createPreviewFixture(harness, { prNumber: 207, lastHandledSha: "sha-icons" });

            await createPreviewEnvironment(harness, fixture, {
                status: "ready",
                manifest: {
                    apps: [
                        { name: "api", port: 4000 },
                        { name: "backend", port: 4001 },
                        { name: "worker", port: 5000 },
                        { name: "web", port: 3000, primary: true },
                    ],
                    services: [
                        { name: "gateway", recipe: "api-gateway" },
                        { name: "mongo", recipe: "mongodb" },
                        { name: "postgres", recipe: "postgres" },
                        { name: "redis", recipe: "redis" },
                        { name: "temporal", recipe: "temporal" },
                        { name: "upstash", recipe: "upstash" },
                        { name: "valkey", recipe: "valkey" },
                        { name: "custom-image", recipe: "docker-image" },
                        { name: "unknown-thing", recipe: "unknown-recipe" },
                    ],
                    addons: [{ name: "neon-db", provider: "neon" }],
                },
                urls: { web: "https://web-pr207.preview.example.com" },
                appBuilds: {
                    api: { status: "ok", imageTag: "api:sha-icons", durationMs: 1000, logUrl: "https://logs/api" },
                    backend: {
                        status: "ok",
                        imageTag: "backend:sha-icons",
                        durationMs: 1000,
                        logUrl: "https://logs/backend",
                        runtime: "node",
                    },
                    worker: {
                        status: "ok",
                        imageTag: "worker:sha-icons",
                        durationMs: 1000,
                        logUrl: "https://logs/worker",
                    },
                    web: { status: "ok", imageTag: "web:sha-icons", durationMs: 1000, logUrl: "https://logs/web" },
                },
                appInstances: [
                    {
                        appName: "api",
                        imageTag: "api:sha-icons",
                        url: "https://api-pr207.preview.example.com",
                        port: 4000,
                    },
                    {
                        appName: "backend",
                        imageTag: "backend:sha-icons",
                        url: "https://backend-pr207.preview.example.com",
                        port: 4001,
                    },
                    {
                        appName: "worker",
                        imageTag: "worker:sha-icons",
                        url: "https://worker-pr207.preview.example.com",
                        port: 5000,
                    },
                    {
                        appName: "web",
                        imageTag: "web:sha-icons",
                        url: "https://web-pr207.preview.example.com",
                        port: 3000,
                    },
                ],
                addons: [
                    { name: "neon-db", provider: "neon", status: "ok", outputs: { host: "db.preview.example.com" } },
                ],
            });

            const summary = await harness.request().deployments.previewSummaryByPr({
                applicationId: fixture.application.id,
                prNumber: fixture.prNumber,
            });

            const iconByName = Object.fromEntries(summary.services.map((service) => [service.name, service.iconKey]));
            expect(iconByName).toMatchObject({
                api: "api",
                backend: "node",
                worker: "worker",
                web: "web",
                gateway: "api-gateway",
                mongo: "mongodb",
                postgres: "postgres",
                redis: "redis",
                temporal: "temporal",
                upstash: "upstash",
                valkey: "valkey",
                "custom-image": "docker-image",
                "unknown-thing": "service",
                "neon-db": "postgres",
            });
        });

        test("returns missing when no preview environment exists", async ({ harness }) => {
            const fixture = await createPreviewFixture(harness, { prNumber: 202, lastHandledSha: "sha-missing" });

            const summary = await harness.request().deployments.previewSummaryByPr({
                applicationId: fixture.application.id,
                prNumber: fixture.prNumber,
            });

            expect(summary.status).toBe("missing");
            expect(summary.primaryUrl).toBeNull();
            expect(summary.serviceCount).toBe(0);
            expect(summary.actions.openPreview.enabled).toBe(false);
        });

        test("returns failed service detail from failed app build", async ({ harness }) => {
            const fixture = await createPreviewFixture(harness, { prNumber: 203, lastHandledSha: "sha-failed" });

            await createPreviewEnvironment(harness, fixture, {
                status: "failed",
                manifest: { apps: [{ name: "web", port: 3000, primary: true }], services: [], addons: [] },
                urls: {},
                appBuilds: {
                    web: {
                        status: "failed",
                        durationMs: 500,
                        error: "Build command failed",
                        logUrl: "https://logs.example.com/web-failed",
                    },
                },
            });

            const summary = await harness.request().deployments.previewSummaryByPr({
                applicationId: fixture.application.id,
                prNumber: fixture.prNumber,
            });

            expect(summary.status).toBe("failed");
            expect(summary.failedServiceCount).toBe(1);
            expect(summary.services[0]).toMatchObject({
                name: "web",
                status: "failed",
                buildLogUrl: "https://logs.example.com/web-failed",
                statusReason: "Build command failed",
            });
        });

        test("returns degraded when one app fails but primary preview is usable", async ({ harness }) => {
            const fixture = await createPreviewFixture(harness, { prNumber: 204, lastHandledSha: "sha-degraded" });

            await createPreviewEnvironment(harness, fixture, {
                status: "ready",
                manifest: {
                    apps: [
                        { name: "web", port: 3000, primary: true },
                        { name: "api", port: 4000 },
                    ],
                    services: [],
                    addons: [],
                },
                urls: { web: "https://web-pr204.preview.example.com" },
                appBuilds: {
                    web: {
                        status: "ok",
                        imageTag: "web:sha-degraded",
                        durationMs: 1000,
                        logUrl: "https://logs.example.com/web",
                    },
                    api: {
                        status: "failed",
                        durationMs: 600,
                        error: "API build failed",
                        logUrl: "https://logs.example.com/api",
                    },
                },
                appInstances: [
                    {
                        appName: "web",
                        imageTag: "web:sha-degraded",
                        url: "https://web-pr204.preview.example.com",
                        port: 3000,
                    },
                ],
            });

            const summary = await harness.request().deployments.previewSummaryByPr({
                applicationId: fixture.application.id,
                prNumber: fixture.prNumber,
            });

            expect(summary.status).toBe("degraded");
            expect(summary.primaryUrl).toBe("https://web-pr204.preview.example.com");
            expect(summary.readyServiceCount).toBe(1);
            expect(summary.failedServiceCount).toBe(1);
        });

        test("returns stale when branch head is newer than deployed head", async ({ harness }) => {
            const fixture = await createPreviewFixture(harness, { prNumber: 205, lastHandledSha: "sha-new" });

            await createPreviewEnvironment(harness, fixture, {
                status: "ready",
                headSha: "sha-old",
                manifest: { apps: [{ name: "web", port: 3000, primary: true }], services: [], addons: [] },
                urls: { web: "https://web-pr205.preview.example.com" },
                appBuilds: {
                    web: {
                        status: "ok",
                        imageTag: "web:sha-old",
                        durationMs: 1000,
                        logUrl: "https://logs.example.com/web",
                    },
                },
                appInstances: [
                    {
                        appName: "web",
                        imageTag: "web:sha-old",
                        url: "https://web-pr205.preview.example.com",
                        port: 3000,
                    },
                ],
            });

            const summary = await harness.request().deployments.previewSummaryByPr({
                applicationId: fixture.application.id,
                prNumber: fixture.prNumber,
            });

            expect(summary.status).toBe("stale");
            expect(summary.headSha).toBe("sha-new");
            expect(summary.lastDeployedSha).toBe("sha-old");
        });

        test("keeps deployments.listByPr backward-compatible", async ({ harness }) => {
            const fixture = await createPreviewFixture(harness, { prNumber: 206, lastHandledSha: "sha-list" });
            const deployment = await harness.db.branchDeployment.create({
                data: {
                    branchId: fixture.branch.id,
                    organizationId: harness.organizationId,
                    webDeployment: {
                        create: {
                            url: "https://classic-preview.example.com",
                            file: "s3://bucket/default-file.png",
                            organizationId: harness.organizationId,
                        },
                    },
                },
            });

            const list = await harness.request().deployments.listByPr({
                applicationId: fixture.application.id,
                prNumber: fixture.prNumber,
            });

            expect(list).toEqual([
                expect.objectContaining({
                    id: deployment.id,
                    url: "https://classic-preview.example.com",
                }),
            ]);
        });
    },
});

async function createPreviewFixture(
    harness: APITestHarness,
    input: {
        prNumber: number;
        lastHandledSha: string;
    },
) {
    const application = await harness.services.applications.createApplication({
        name: `Preview App ${input.prNumber}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/default-file.png",
    });
    await harness.db.application.update({
        where: { id: application.id },
        data: { githubRepositoryId: 10_000 + input.prNumber },
    });
    const branch = await harness.db.branch.create({
        data: {
            name: `feat/preview-${input.prNumber}`,
            lastHandledSha: input.lastHandledSha,
            applicationId: application.id,
            organizationId: harness.organizationId,
            prInfo: { create: { applicationId: application.id, prNumber: input.prNumber } },
        },
    });

    return {
        application: { ...application, githubRepositoryId: 10_000 + input.prNumber },
        branch,
        prNumber: input.prNumber,
    };
}

async function createPreviewEnvironment(
    harness: APITestHarness,
    fixture: Awaited<ReturnType<typeof createPreviewFixture>>,
    input: {
        status: "pending" | "building" | "deploying" | "ready" | "failed" | "torn_down";
        headSha?: string;
        manifest: {
            apps: Array<{ name: string; port: number; primary?: boolean }>;
            services: Array<{ name: string; recipe: string; version?: string }>;
            addons: Array<{ name: string; provider: string }>;
        };
        urls: Record<string, string>;
        appBuilds: Record<
            string,
            | { status: "ok"; imageTag: string; durationMs: number; logUrl: string; runtime?: string }
            | { status: "failed"; durationMs: number; error: string; logUrl?: string; runtime?: string }
        >;
        appInstances?: Array<{ appName: string; imageTag: string; url: string; port: number }>;
        addons?: Array<{
            name: string;
            provider: string;
            status: "pending" | "ok" | "failed" | "deprovisioned";
            outputs?: Record<string, string>;
            error?: string;
        }>;
    },
) {
    const headSha = input.headSha ?? fixture.branch.lastHandledSha ?? "sha";
    const environment = await harness.db.previewkitEnvironment.create({
        data: {
            namespace: `preview-test-pr-${fixture.prNumber}`,
            repoFullName: `Autonoma-AI/preview-test-${fixture.prNumber}`,
            prNumber: fixture.prNumber,
            headSha,
            headRef: fixture.branch.name,
            githubRepositoryId: fixture.application.githubRepositoryId,
            organizationId: harness.organizationId,
            status: input.status,
            phase: input.status === "ready" ? "ready" : input.status,
            urls: input.urls,
            manifest: input.manifest,
            deployedAt: input.status === "ready" ? new Date() : null,
        },
    });

    await harness.db.previewkitBuild.create({
        data: {
            environmentId: environment.id,
            headSha,
            status: input.status === "ready" ? "ready" : input.status === "failed" ? "failed" : "building",
            durationMs: 1000,
            finishedAt: new Date(),
            appBuilds: input.appBuilds,
            error: input.status === "failed" ? "Preview build failed" : null,
        },
    });

    for (const app of input.appInstances ?? []) {
        await harness.db.previewkitAppInstance.create({
            data: {
                environmentId: environment.id,
                appName: app.appName,
                imageTag: app.imageTag,
                url: app.url,
                port: app.port,
                ready: true,
            },
        });
    }

    for (const addon of input.addons ?? []) {
        await harness.db.previewkitAddon.create({
            data: {
                environmentId: environment.id,
                name: addon.name,
                provider: addon.provider,
                status: addon.status,
                outputs: addon.outputs ?? {},
                error: addon.error,
                provisionedAt: addon.status === "ok" ? new Date() : null,
            },
        });
    }
}
