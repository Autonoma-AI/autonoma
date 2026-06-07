import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import {
    recordBuildFinished,
    recordEnvironmentCreated,
    recordEnvironmentReady,
    recordEnvironmentTornDown,
    recordPhaseChanged,
} from "../../src/db";
import { PreviewkitTestHarness } from "./harness";

integrationTestSuite({
    name: "previewkit database",
    createHarness: () => PreviewkitTestHarness.create(),
    cases: (test) => {
        test("recordEnvironmentCreated creates an environment row for a known installation", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");

            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "feature/login",
                namespace: "preview-acme-web-pr-7",
                commentId: "100",
            });

            const env = await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-7" },
            });

            expect(env).not.toBeNull();
            expect(env!.organizationId).toBe(organizationId);
            expect(env!.repoFullName).toBe("acme/web");
            expect(env!.prNumber).toBe(7);
            expect(env!.headSha).toBe("abc1234");
            expect(env!.headRef).toBe("feature/login");
            expect(env!.commentId).toBe("100");
            expect(env!.status).toBe("pending");
            expect(env!.phase).toBe("initializing");
        });

        test("recordEnvironmentCreated is idempotent on namespace (resets error, tornDownAt, config snapshot)", async ({
            harness,
        }) => {
            const organizationId = await harness.createInstallationForOwner("acme");

            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "old-sha",
                headRef: "feature/login",
                namespace: "preview-acme-web-pr-7",
            });

            // Simulate a prior failed+torn-down state (with a stale config snapshot)
            // being overwritten by a fresh deploy.
            await harness.db.previewkitEnvironment.update({
                where: { namespace: "preview-acme-web-pr-7" },
                data: {
                    status: "failed",
                    error: "boom",
                    tornDownAt: new Date(),
                    resolvedConfig: { version: 1, apps: [{ name: "web", port: 3000 }] },
                    configRevisionId: "rev_prior",
                },
            });

            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "new-sha",
                headRef: "feature/login-v2",
                namespace: "preview-acme-web-pr-7",
                commentId: "200",
            });

            const env = await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-7" },
            });
            expect(env!.headSha).toBe("new-sha");
            expect(env!.headRef).toBe("feature/login-v2");
            expect(env!.commentId).toBe("200");
            expect(env!.status).toBe("pending");
            expect(env!.phase).toBe("initializing");
            expect(env!.error).toBeNull();
            expect(env!.tornDownAt).toBeNull();
            // A fresh attempt clears the prior config snapshot; it is rewritten once
            // this attempt resolves its config.
            expect(env!.resolvedConfig).toBeNull();
            expect(env!.configRevisionId).toBeNull();
        });

        test("recordPhaseChanged updates status, phase, error, and deployedAt on ready", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");

            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });

            await recordPhaseChanged({
                namespace: "preview-acme-web-pr-7",
                status: "building",
                phase: "building-images",
            });

            let env = await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-7" },
            });
            expect(env!.status).toBe("building");
            expect(env!.phase).toBe("building-images");
            expect(env!.deployedAt).toBeNull();

            await recordPhaseChanged({
                namespace: "preview-acme-web-pr-7",
                status: "ready",
                phase: "ready",
            });

            env = await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-7" },
            });
            expect(env!.status).toBe("ready");
            expect(env!.deployedAt).not.toBeNull();
        });

        test("recordPhaseChanged records error message on failure", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");

            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });

            await recordPhaseChanged({
                namespace: "preview-acme-web-pr-7",
                status: "failed",
                phase: "failed",
                error: "nixpacks detection failed",
            });

            const env = await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-7" },
            });
            expect(env!.status).toBe("failed");
            expect(env!.error).toBe("nixpacks detection failed");
        });

        test("recordBuildFinished creates a build row tied to the environment", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");

            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });

            await recordBuildFinished({
                namespace: "preview-acme-web-pr-7",
                headSha: "abc1234",
                status: "building",
                durationMs: 42_000,
                appBuilds: {
                    web: {
                        status: "success",
                        imageTag: "ghcr.io/acme/web:pr-7-abc1234",
                        durationMs: 30_000,
                        logUrl: "s3://logs/web.log",
                    },
                    api: {
                        status: "success",
                        imageTag: "ghcr.io/acme/api:pr-7-abc1234",
                        durationMs: 12_000,
                        logUrl: "s3://logs/api.log",
                    },
                },
            });

            const env = await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-7" },
                include: { builds: { include: { appBuilds: true } } },
            });
            expect(env!.builds).toHaveLength(1);
            const build = env!.builds[0]!;
            expect(build.headSha).toBe("abc1234");
            expect(build.durationMs).toBe(42_000);
            expect(build.status).toBe("building");
            expect(build.finishedAt).not.toBeNull();

            const appBuildsByName = new Map(build.appBuilds.map((appBuild) => [appBuild.appName, appBuild]));
            expect(appBuildsByName.get("web")).toMatchObject({
                status: "success",
                imageTag: "ghcr.io/acme/web:pr-7-abc1234",
                durationMs: 30_000,
            });
            expect(appBuildsByName.get("api")).toMatchObject({
                status: "success",
                imageTag: "ghcr.io/acme/api:pr-7-abc1234",
                durationMs: 12_000,
            });
        });

        test("recordBuildFinished records error message on failed builds", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");

            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });

            await recordBuildFinished({
                namespace: "preview-acme-web-pr-7",
                headSha: "abc1234",
                status: "failed",
                durationMs: 5_000,
                appBuilds: {},
                error: "Dockerfile not found",
            });

            const env = await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-7" },
                include: { builds: true },
            });
            const build = env!.builds[0]!;
            expect(build.status).toBe("failed");
            expect(build.error).toBe("Dockerfile not found");
        });

        test("recordBuildFinished skips silently when environment does not exist", async ({ harness }) => {
            await recordBuildFinished({
                namespace: "preview-missing",
                headSha: "abc1234",
                status: "building",
                durationMs: 1_000,
                appBuilds: {},
            });

            const builds = await harness.db.previewkitBuild.findMany();
            expect(builds).toHaveLength(0);
        });

        test("recordEnvironmentReady updates env and upserts app instances with ready=false", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");

            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });

            await recordEnvironmentReady({
                namespace: "preview-acme-web-pr-7",
                urls: {
                    web: "https://web-pr-7-acme.preview.autonoma.app",
                    api: "https://api-pr-7-acme.preview.autonoma.app",
                },
                apps: [
                    { appName: "web", imageTag: "ghcr.io/acme/web:pr-7-abc1234", port: 3000 },
                    { appName: "api", imageTag: "ghcr.io/acme/api:pr-7-abc1234", port: 4000 },
                ],
            });

            const env = await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-7" },
                include: { appInstances: { orderBy: { appName: "asc" } } },
            });
            expect(env!.status).toBe("ready");
            expect(env!.phase).toBe("ready");
            expect(env!.deployedAt).not.toBeNull();
            expect(env!.urls).toEqual({
                web: "https://web-pr-7-acme.preview.autonoma.app",
                api: "https://api-pr-7-acme.preview.autonoma.app",
            });

            expect(env!.appInstances).toHaveLength(2);
            const api = env!.appInstances.find((a) => a.appName === "api")!;
            expect(api.imageTag).toBe("ghcr.io/acme/api:pr-7-abc1234");
            expect(api.url).toBe("https://api-pr-7-acme.preview.autonoma.app");
            expect(api.port).toBe(4000);
            expect(api.ready).toBe(false);
        });

        test("recordEnvironmentReady upserts are idempotent across redeploys", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");

            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });

            await recordEnvironmentReady({
                namespace: "preview-acme-web-pr-7",
                urls: { web: "https://old" },
                apps: [{ appName: "web", imageTag: "ghcr.io/acme/web:pr-7-old", port: 3000 }],
            });

            // Simulate operator-flipped readiness, then a redeploy. The redeploy
            // should reset ready to false per current semantics.
            await harness.db.previewkitAppInstance.updateMany({ data: { ready: true } });

            await recordEnvironmentReady({
                namespace: "preview-acme-web-pr-7",
                urls: { web: "https://new" },
                apps: [{ appName: "web", imageTag: "ghcr.io/acme/web:pr-7-new", port: 3000 }],
            });

            const instances = await harness.db.previewkitAppInstance.findMany();
            expect(instances).toHaveLength(1);
            const web = instances[0]!;
            expect(web.imageTag).toBe("ghcr.io/acme/web:pr-7-new");
            expect(web.url).toBe("https://new");
            expect(web.ready).toBe(false);
        });

        test("recordEnvironmentTornDown marks env torn_down and stamps tornDownAt", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");

            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });

            await recordEnvironmentTornDown("preview-acme-web-pr-7");

            const env = await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-7" },
            });
            expect(env!.status).toBe("torn_down");
            expect(env!.phase).toBe("torn_down");
            expect(env!.tornDownAt).not.toBeNull();
        });
    },
});
