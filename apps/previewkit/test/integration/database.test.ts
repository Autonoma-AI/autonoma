import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import {
    markBuildSuperseded,
    recordAppsPending,
    recordAppStates,
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
                    },
                    api: {
                        status: "success",
                        imageTag: "ghcr.io/acme/api:pr-7-abc1234",
                        durationMs: 12_000,
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

        test("recordBuildFinished is idempotent on (environment, sha): a retry updates one row and replaces app builds", async ({
            harness,
        }) => {
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
                durationMs: 10_000,
                appBuilds: {
                    web: { status: "success", imageTag: "ghcr.io/acme/web:v1", durationMs: 9_000, logUrl: "s3://a" },
                },
            });

            // A Temporal retry of the build activity re-runs with the same sha.
            await recordBuildFinished({
                namespace: "preview-acme-web-pr-7",
                headSha: "abc1234",
                status: "failed",
                durationMs: 20_000,
                error: "second attempt failed",
                appBuilds: {
                    web: { status: "failed", durationMs: 19_000, error: "boom" },
                },
            });

            const builds = await harness.db.previewkitBuild.findMany({ include: { appBuilds: true } });
            expect(builds).toHaveLength(1);
            expect(builds[0]!.status).toBe("failed");
            expect(builds[0]!.error).toBe("second attempt failed");
            // App rows were replaced, not duplicated.
            expect(builds[0]!.appBuilds).toHaveLength(1);
            expect(builds[0]!.appBuilds[0]!.status).toBe("failed");
        });

        test("markBuildSuperseded marks the build superseded and leaves the env row untouched", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });
            // The env row is mid-build and belongs to the newest run.
            await recordPhaseChanged({
                namespace: "preview-acme-web-pr-7",
                status: "building",
                phase: "building-images",
            });

            await markBuildSuperseded("preview-acme-web-pr-7", "abc1234");

            const env = await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-7" },
                include: { builds: true },
            });
            // Env row is NOT touched - the successor run owns it.
            expect(env!.status).toBe("building");
            expect(env!.phase).toBe("building-images");
            // The build row is finalized as superseded.
            expect(env!.builds).toHaveLength(1);
            expect(env!.builds[0]!.status).toBe("superseded");
            expect(env!.builds[0]!.finishedAt).not.toBeNull();
        });

        test("markBuildSuperseded is idempotent", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });

            await markBuildSuperseded("preview-acme-web-pr-7", "abc1234");
            await markBuildSuperseded("preview-acme-web-pr-7", "abc1234");

            const builds = await harness.db.previewkitBuild.findMany();
            expect(builds).toHaveLength(1);
            expect(builds[0]!.status).toBe("superseded");
        });

        test("markBuildSuperseded skips silently when environment does not exist", async ({ harness }) => {
            await markBuildSuperseded("preview-missing", "abc1234");
            const builds = await harness.db.previewkitBuild.findMany();
            expect(builds).toHaveLength(0);
        });

        test("recordEnvironmentReady marks the environment row ready", async ({ harness }) => {
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
            });

            const env = await harness.db.previewkitEnvironment.findUnique({
                where: { namespace: "preview-acme-web-pr-7" },
            });
            expect(env!.status).toBe("ready");
            expect(env!.phase).toBe("ready");
            expect(env!.deployedAt).not.toBeNull();
            expect(env!.urls).toEqual({
                web: "https://web-pr-7-acme.preview.autonoma.app",
                api: "https://api-pr-7-acme.preview.autonoma.app",
            });
        });

        test("recordAppsPending seeds a pending lifecycle row per app at moment 0", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });

            await recordAppsPending("preview-acme-web-pr-7", [
                { appName: "web", port: 3000 },
                { appName: "api", port: 4000 },
            ]);

            const instances = await harness.db.previewkitAppInstance.findMany({ orderBy: { appName: "asc" } });
            expect(instances).toHaveLength(2);
            for (const instance of instances) {
                expect(instance.status).toBe("pending");
                expect(instance.imageTag).toBeNull();
                expect(instance.url).toBeNull();
            }
            expect(instances.find((i) => i.appName === "api")!.port).toBe(4000);
        });

        test("recordAppsPending prunes dropped apps and resets the rest on redeploy", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });

            await recordAppsPending("preview-acme-web-pr-7", [
                { appName: "web", port: 3000 },
                { appName: "api", port: 4000 },
            ]);
            // web reaches ready on the first commit...
            await recordAppStates("preview-acme-web-pr-7", [
                { appName: "web", status: "ready", port: 3000, imageTag: "web:v1", url: "https://web" },
            ]);

            // ...then a new commit drops `api` from the config and redeploys.
            await recordAppsPending("preview-acme-web-pr-7", [{ appName: "web", port: 3000 }]);

            const instances = await harness.db.previewkitAppInstance.findMany();
            expect(instances).toHaveLength(1);
            const web = instances[0]!;
            expect(web.appName).toBe("web");
            // Reset back to pending, clearing the prior commit's imageTag/url.
            expect(web.status).toBe("pending");
            expect(web.imageTag).toBeNull();
            expect(web.url).toBeNull();
        });

        test("recordAppStates transitions an app through the full lifecycle", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });
            const ns = "preview-acme-web-pr-7";
            await recordAppsPending(ns, [{ appName: "web", port: 3000 }]);

            await recordAppStates(ns, [{ appName: "web", status: "building", port: 3000 }]);
            await recordAppStates(ns, [{ appName: "web", status: "built", port: 3000, imageTag: "web:v1" }]);
            await recordAppStates(ns, [{ appName: "web", status: "deploying", port: 3000, imageTag: "web:v1" }]);
            await recordAppStates(ns, [
                { appName: "web", status: "ready", port: 3000, imageTag: "web:v1", url: "https://web" },
            ]);

            const web = await harness.db.previewkitAppInstance.findFirstOrThrow({ where: { appName: "web" } });
            expect(web.status).toBe("ready");
            expect(web.imageTag).toBe("web:v1");
            expect(web.url).toBe("https://web");
            expect(web.error).toBeNull();
        });

        test("recordAppStates records build_failed and deploy_failed as distinct rows", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });
            const ns = "preview-acme-web-pr-7";
            await recordAppsPending(ns, [
                { appName: "web", port: 3000 },
                { appName: "api", port: 4000 },
                { appName: "worker", port: 5000 },
            ]);

            // web deploys, api fails its build, worker builds but fails to deploy.
            await recordAppStates(ns, [
                { appName: "web", status: "ready", port: 3000, imageTag: "web:v1", url: "https://web" },
                { appName: "api", status: "build_failed", port: 4000, error: "tsc failed" },
                {
                    appName: "worker",
                    status: "deploy_failed",
                    port: 5000,
                    imageTag: "worker:v1",
                    error: "CrashLoopBackOff",
                },
            ]);

            const instances = await harness.db.previewkitAppInstance.findMany({ orderBy: { appName: "asc" } });
            const byName = Object.fromEntries(instances.map((i) => [i.appName, i]));
            expect(byName.web!.status).toBe("ready");
            expect(byName.api!.status).toBe("build_failed");
            expect(byName.api!.error).toBe("tsc failed");
            expect(byName.api!.imageTag).toBeNull();
            expect(byName.worker!.status).toBe("deploy_failed");
            expect(byName.worker!.error).toBe("CrashLoopBackOff");
            // worker built successfully, so its image tag is retained even though the deploy failed.
            expect(byName.worker!.imageTag).toBe("worker:v1");
        });

        test("recordAppStates overwrites mutable fields on redeploy", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            await recordEnvironmentCreated({
                repoFullName: "acme/web",
                organizationId,
                prNumber: 7,
                headSha: "abc1234",
                headRef: "main",
                namespace: "preview-acme-web-pr-7",
            });
            const ns = "preview-acme-web-pr-7";
            await recordAppsPending(ns, [{ appName: "web", port: 3000 }]);

            await recordAppStates(ns, [
                { appName: "web", status: "ready", port: 3000, imageTag: "web:old", url: "https://old" },
            ]);
            await recordAppStates(ns, [
                { appName: "web", status: "ready", port: 3000, imageTag: "web:new", url: "https://new" },
            ]);

            const instances = await harness.db.previewkitAppInstance.findMany();
            expect(instances).toHaveLength(1);
            const web = instances[0]!;
            expect(web.imageTag).toBe("web:new");
            expect(web.url).toBe("https://new");
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
