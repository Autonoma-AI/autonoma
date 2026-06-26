import { ApplicationArchitecture, type PreviewkitStatus } from "@autonoma/db";
import { ConflictError, NotFoundError } from "@autonoma/errors";
import { expect, vi } from "vitest";
import { PreviewkitTriggerService } from "../../src/previewkit/previewkit-trigger.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

const REPO_ID = 2001;
const REPO_FULL_NAME = "acme/web";

function pullRequestPayload(prNumber: number, draft = false): Record<string, unknown> {
    return {
        pull_request: {
            number: prNumber,
            draft,
            head: { sha: `head-${prNumber}`, ref: `feature/pr-${prNumber}` },
            base: { sha: "main-sha-2", ref: "main" },
        },
        repository: {
            id: REPO_ID,
            full_name: REPO_FULL_NAME,
            clone_url: "https://github.com/acme/web.git",
        },
    };
}

function pushPayload(branch: string, sha: string, deleted = false): Record<string, unknown> {
    return {
        ref: `refs/heads/${branch}`,
        after: sha,
        deleted,
        repository: {
            id: REPO_ID,
            full_name: REPO_FULL_NAME,
            clone_url: "https://github.com/acme/web.git",
        },
    };
}

/** Puts the shared main-branch environment row (environment 0) into the state a case needs. */
async function setMainBranchEnvironment(
    harness: APITestHarness,
    headRef: string,
    status: PreviewkitStatus,
): Promise<void> {
    await harness.db.previewkitEnvironment.upsert({
        where: { repoFullName_prNumber: { repoFullName: REPO_FULL_NAME, prNumber: 0 } },
        create: {
            namespace: "preview-acme-web-pr-0",
            repoFullName: REPO_FULL_NAME,
            prNumber: 0,
            headSha: "main-sha-1",
            headRef,
            githubRepositoryId: REPO_ID,
            status,
            organizationId: harness.organizationId,
        },
        update: {
            namespace: "preview-acme-web-pr-0",
            headSha: "main-sha-1",
            headRef,
            githubRepositoryId: REPO_ID,
            status,
            organizationId: harness.organizationId,
        },
    });
}

apiTestSuite({
    name: "PreviewkitTriggerService",
    seed: async ({ harness }) => {
        const service = harness.services.previewkitTrigger;
        const fakeClient = harness.githubApp.defaultClient;

        fakeClient.addRepository({
            id: REPO_ID,
            name: "web",
            fullName: REPO_FULL_NAME,
            defaultBranch: "main",
            commits: ["main-sha-1", "main-sha-2"],
        });

        const app = await harness.services.applications.createApplication({
            name: "Preview App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/file.png",
        });
        await harness.db.application.update({
            where: { id: app.id },
            data: { githubRepositoryId: REPO_ID },
        });

        await harness.services.github.handleInstallation(54321, harness.organizationId, "acme", 777, "Organization");

        return { app, service };
    },
    cases: (test) => {
        test("deployFromWebhook starts a deploy workflow with the PR event", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();

            await service.deployFromWebhook("synchronize", harness.organizationId, pullRequestPayload(7));

            expect(harness.triggerWorkflow).toHaveBeenCalledTimes(1);
            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                event: {
                    action: "synchronize",
                    prNumber: 7,
                    repoFullName: REPO_FULL_NAME,
                    organizationId: harness.organizationId,
                    githubRepositoryId: REPO_ID,
                    headSha: "head-7",
                    headRef: "feature/pr-7",
                    baseSha: "main-sha-2",
                    baseRef: "main",
                    cloneUrl: "https://github.com/acme/web.git",
                },
                configRevisionId: undefined,
            });
        });

        test("deployFromWebhook skips a draft PR when previewkitBuildDraft is disabled", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();

            await service.deployFromWebhook("opened", harness.organizationId, pullRequestPayload(20, true));

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("deployFromWebhook builds a draft PR when previewkitBuildDraft is enabled", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, previewkitBuildDraft: true },
                update: { previewkitBuildDraft: true },
            });

            await service.deployFromWebhook("opened", harness.organizationId, pullRequestPayload(21, true));

            expect(harness.triggerWorkflow).toHaveBeenCalledTimes(1);

            await harness.db.organizationSettings.delete({ where: { organizationId: harness.organizationId } });
        });

        test("deployFromWebhook builds a ready-for-review PR even when previewkitBuildDraft is disabled", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();

            // A PR marked ready for review is no longer a draft (draft: false),
            // so it deploys regardless of the org's draft-build setting.
            await service.deployFromWebhook("ready_for_review", harness.organizationId, pullRequestPayload(22, false));

            expect(harness.triggerWorkflow).toHaveBeenCalledTimes(1);
            expect(harness.triggerWorkflow).toHaveBeenCalledWith(
                expect.objectContaining({
                    event: expect.objectContaining({ action: "ready_for_review", prNumber: 22 }),
                }),
            );
        });

        test("deployFromWebhook skips an unparseable payload without triggering", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();

            await service.deployFromWebhook("opened", harness.organizationId, { repository: { id: REPO_ID } });

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("teardownFromWebhook starts a teardown carrying the head sha", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();

            await service.teardownFromWebhook(harness.organizationId, pullRequestPayload(9));

            expect(harness.triggerWorkflow).toHaveBeenCalledTimes(1);
            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                event: {
                    action: "closed",
                    prNumber: 9,
                    repoFullName: REPO_FULL_NAME,
                    organizationId: harness.organizationId,
                    githubRepositoryId: REPO_ID,
                    headSha: "head-9",
                    headRef: "feature/pr-9",
                    baseSha: "",
                    baseRef: "",
                    cloneUrl: "",
                },
            });
        });

        test("deployMainBranch resolves the branch head and deploys environment 0", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.triggerWorkflow.mockClear();

            const result = await service.deployMainBranch(app.id, harness.organizationId);

            expect(result).toEqual({
                applicationId: app.id,
                repoFullName: REPO_FULL_NAME,
                branch: "main",
                headSha: "main-sha-2",
                prNumber: 0,
            });
            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                event: {
                    action: "synchronize",
                    prNumber: 0,
                    repoFullName: REPO_FULL_NAME,
                    organizationId: harness.organizationId,
                    githubRepositoryId: REPO_ID,
                    headSha: "main-sha-2",
                    headRef: "main",
                    baseSha: "main-sha-2",
                    baseRef: "main",
                    cloneUrl: "https://github.com/acme/web.git",
                },
                configRevisionId: undefined,
            });
        });

        test("deployMainBranch rejects an application outside the caller's org", async ({
            seedResult: { app, service },
        }) => {
            await expect(service.deployMainBranch(app.id, "some-other-org")).rejects.toThrow(NotFoundError);
        });

        test("deployMainBranch rejects a disabled application", async ({ harness, seedResult: { service } }) => {
            const disabledApp = await harness.services.applications.createApplication({
                name: "Disabled App",
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/file.png",
            });
            // (organizationId, githubRepositoryId) is unique, and the disabled
            // check fires before any GitHub lookup - any repo id works here.
            await harness.db.application.update({
                where: { id: disabledApp.id },
                data: { githubRepositoryId: REPO_ID + 1, disabled: true },
            });

            await expect(service.deployMainBranch(disabledApp.id, harness.organizationId)).rejects.toThrow(
                ConflictError,
            );
        });

        test("deployMainBranch rejects an application with no linked repository", async ({
            harness,
            seedResult: { service },
        }) => {
            const unlinkedApp = await harness.services.applications.createApplication({
                name: "Unlinked App",
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/file.png",
            });

            await expect(service.deployMainBranch(unlinkedApp.id, harness.organizationId)).rejects.toThrow(
                ConflictError,
            );
        });

        test("deployMainBranch rejects a suspended installation", async ({ harness, seedResult: { app, service } }) => {
            await harness.db.gitHubInstallation.update({
                where: { organizationId: harness.organizationId },
                data: { status: "suspended" },
            });
            try {
                await expect(service.deployMainBranch(app.id, harness.organizationId)).rejects.toThrow(
                    /GitHub installation is suspended/,
                );
            } finally {
                await harness.db.gitHubInstallation.update({
                    where: { organizationId: harness.organizationId },
                    data: { status: "active" },
                });
            }
        });

        test("deployMainBranch maps GitHub 404s to NotFoundError", async ({ harness, seedResult: { app } }) => {
            const notFound = Object.assign(new Error("Not Found"), { status: 404 });
            const deploySpy = vi.fn().mockResolvedValue(undefined);

            const repoMissing = new PreviewkitTriggerService(
                harness.db,
                {
                    getRepository: () => Promise.reject(notFound),
                    getBranchHead: () => Promise.reject(notFound),
                },
                deploySpy,
                deploySpy,
                deploySpy,
            );
            await expect(repoMissing.deployMainBranch(app.id, harness.organizationId)).rejects.toThrow(
                /Linked GitHub repository not found/,
            );

            const branchMissing = new PreviewkitTriggerService(
                harness.db,
                {
                    getRepository: () =>
                        Promise.resolve({
                            id: REPO_ID,
                            name: "web",
                            fullName: REPO_FULL_NAME,
                            defaultBranch: "main",
                            private: false,
                        }),
                    getBranchHead: () => Promise.reject(notFound),
                },
                deploySpy,
                deploySpy,
                deploySpy,
            );
            await expect(branchMissing.deployMainBranch(app.id, harness.organizationId)).rejects.toThrow(
                /Main branch ref 'main' not found/,
            );
            expect(deploySpy).not.toHaveBeenCalled();
        });

        test("deployMainBranchFromPushWebhook updates environment 0 on a push to the tracked branch", async ({
            harness,
            seedResult: { service },
        }) => {
            await setMainBranchEnvironment(harness, "main", "ready");
            harness.triggerWorkflow.mockClear();

            await expect(
                service.pushTargetsMainBranchEnvironment(harness.organizationId, pushPayload("main", "push-sha-1")),
            ).resolves.toBe(true);

            await service.deployMainBranchFromPushWebhook(harness.organizationId, pushPayload("main", "push-sha-1"));

            expect(harness.triggerWorkflow).toHaveBeenCalledTimes(1);
            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                event: {
                    action: "synchronize",
                    prNumber: 0,
                    repoFullName: REPO_FULL_NAME,
                    organizationId: harness.organizationId,
                    githubRepositoryId: REPO_ID,
                    headSha: "push-sha-1",
                    headRef: "main",
                    baseSha: "push-sha-1",
                    baseRef: "main",
                    cloneUrl: "https://github.com/acme/web.git",
                },
                configRevisionId: undefined,
            });
        });

        test("deployMainBranchFromPushWebhook ignores a push to a branch the environment does not track", async ({
            harness,
            seedResult: { service },
        }) => {
            await setMainBranchEnvironment(harness, "main", "ready");
            harness.triggerWorkflow.mockClear();

            await service.deployMainBranchFromPushWebhook(harness.organizationId, pushPayload("develop", "push-sha-2"));

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("deployMainBranchFromPushWebhook ignores a push when the environment is torn down", async ({
            harness,
            seedResult: { service },
        }) => {
            await setMainBranchEnvironment(harness, "main", "torn_down");
            harness.triggerWorkflow.mockClear();

            await service.deployMainBranchFromPushWebhook(harness.organizationId, pushPayload("main", "push-sha-3"));

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("deployMainBranchFromPushWebhook ignores a repo without a main-branch environment", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();
            const unrelatedRepoPush = {
                ref: "refs/heads/main",
                after: "push-sha-4",
                deleted: false,
                repository: {
                    id: 9999,
                    full_name: "acme/unrelated",
                    clone_url: "https://github.com/acme/unrelated.git",
                },
            };

            await expect(
                service.pushTargetsMainBranchEnvironment(harness.organizationId, unrelatedRepoPush),
            ).resolves.toBe(false);

            await service.deployMainBranchFromPushWebhook(harness.organizationId, unrelatedRepoPush);

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("deployMainBranchFromPushWebhook ignores branch deletions, zero-sha pushes and tag pushes", async ({
            harness,
            seedResult: { service },
        }) => {
            await setMainBranchEnvironment(harness, "main", "ready");
            harness.triggerWorkflow.mockClear();

            await service.deployMainBranchFromPushWebhook(
                harness.organizationId,
                pushPayload("main", "push-sha-5", true),
            );
            await service.deployMainBranchFromPushWebhook(harness.organizationId, pushPayload("main", "0".repeat(40)));
            await service.deployMainBranchFromPushWebhook(harness.organizationId, {
                ref: "refs/tags/v1.0.0",
                after: "push-sha-6",
                deleted: false,
                repository: {
                    id: REPO_ID,
                    full_name: REPO_FULL_NAME,
                    clone_url: "https://github.com/acme/web.git",
                },
            });

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("deployMainBranchFromPushWebhook scopes to the webhook's organization", async ({
            harness,
            seedResult: { service },
        }) => {
            await setMainBranchEnvironment(harness, "main", "ready");
            harness.triggerWorkflow.mockClear();

            await service.deployMainBranchFromPushWebhook("some-other-org", pushPayload("main", "push-sha-7"));

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("deployMainBranchFromPushWebhook skips an unparseable payload without triggering", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();

            await service.deployMainBranchFromPushWebhook(harness.organizationId, { ref: "refs/heads/main" });

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("redeploy reconstructs the event and pins the config revision", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-12",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 12,
                    headSha: "head-12",
                    headRef: "feature/pr-12",
                    githubRepositoryId: REPO_ID,
                    status: "ready",
                    configRevisionId: "rev_original",
                    organizationId: harness.organizationId,
                },
            });

            await service.redeploy(REPO_FULL_NAME, 12, harness.organizationId);

            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                event: {
                    action: "synchronize",
                    prNumber: 12,
                    repoFullName: REPO_FULL_NAME,
                    organizationId: harness.organizationId,
                    githubRepositoryId: REPO_ID,
                    headSha: "head-12",
                    headRef: "feature/pr-12",
                    baseSha: "",
                    baseRef: "",
                    cloneUrl: "",
                },
                configRevisionId: "rev_original",
            });
        });

        test("redeploy rejects a torn-down environment", async ({ harness, seedResult: { service } }) => {
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-13",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 13,
                    headSha: "head-13",
                    headRef: "feature/pr-13",
                    githubRepositoryId: REPO_ID,
                    status: "torn_down",
                    organizationId: harness.organizationId,
                },
            });

            await expect(service.redeploy(REPO_FULL_NAME, 13, harness.organizationId)).rejects.toThrow(ConflictError);
        });

        test("redeploy scopes to the caller's organization", async ({ harness, seedResult: { service } }) => {
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-14",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 14,
                    headSha: "head-14",
                    headRef: "feature/pr-14",
                    githubRepositoryId: REPO_ID,
                    status: "ready",
                    organizationId: harness.organizationId,
                },
            });

            await expect(service.redeploy(REPO_FULL_NAME, 14, "some-other-org")).rejects.toThrow(NotFoundError);
        });

        test("redeployApp reconstructs the event, namespace, app + mode and pins the config revision", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-20",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 20,
                    headSha: "head-20",
                    headRef: "feature/pr-20",
                    githubRepositoryId: REPO_ID,
                    status: "ready",
                    configRevisionId: "rev_original",
                    organizationId: harness.organizationId,
                    appInstances: { create: [{ appName: "web", status: "ready", port: 3000 }] },
                },
            });

            await service.redeployApp(REPO_FULL_NAME, 20, "web", "rebuild", harness.organizationId);

            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                event: {
                    action: "synchronize",
                    prNumber: 20,
                    repoFullName: REPO_FULL_NAME,
                    organizationId: harness.organizationId,
                    githubRepositoryId: REPO_ID,
                    headSha: "head-20",
                    headRef: "feature/pr-20",
                    baseSha: "",
                    baseRef: "",
                    cloneUrl: "",
                },
                namespace: "preview-acme-web-pr-20",
                appName: "web",
                mode: "rebuild",
                configRevisionId: "rev_original",
            });
        });

        test("redeployApp passes restart mode through", async ({ harness, seedResult: { service } }) => {
            harness.triggerWorkflow.mockClear();
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-21",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 21,
                    headSha: "head-21",
                    headRef: "feature/pr-21",
                    githubRepositoryId: REPO_ID,
                    status: "ready",
                    organizationId: harness.organizationId,
                    appInstances: { create: [{ appName: "web", status: "ready", port: 3000 }] },
                },
            });

            await service.redeployApp(REPO_FULL_NAME, 21, "web", "restart", harness.organizationId);

            expect(harness.triggerWorkflow).toHaveBeenCalledWith(
                expect.objectContaining({ appName: "web", mode: "restart", namespace: "preview-acme-web-pr-21" }),
            );
        });

        test("redeployApp rejects an app not in the environment", async ({ harness, seedResult: { service } }) => {
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-22",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 22,
                    headSha: "head-22",
                    headRef: "feature/pr-22",
                    githubRepositoryId: REPO_ID,
                    status: "ready",
                    organizationId: harness.organizationId,
                    appInstances: { create: [{ appName: "web", status: "ready", port: 3000 }] },
                },
            });

            await expect(
                service.redeployApp(REPO_FULL_NAME, 22, "api", "rebuild", harness.organizationId),
            ).rejects.toThrow(NotFoundError);
        });

        test("redeployApp rejects a torn-down environment", async ({ harness, seedResult: { service } }) => {
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-23",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 23,
                    headSha: "head-23",
                    headRef: "feature/pr-23",
                    githubRepositoryId: REPO_ID,
                    status: "torn_down",
                    organizationId: harness.organizationId,
                    appInstances: { create: [{ appName: "web", status: "ready", port: 3000 }] },
                },
            });

            await expect(
                service.redeployApp(REPO_FULL_NAME, 23, "web", "rebuild", harness.organizationId),
            ).rejects.toThrow(ConflictError);
        });

        test("redeployApp scopes to the caller's organization", async ({ harness, seedResult: { service } }) => {
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-24",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 24,
                    headSha: "head-24",
                    headRef: "feature/pr-24",
                    githubRepositoryId: REPO_ID,
                    status: "ready",
                    organizationId: harness.organizationId,
                    appInstances: { create: [{ appName: "web", status: "ready", port: 3000 }] },
                },
            });

            await expect(service.redeployApp(REPO_FULL_NAME, 24, "web", "rebuild", "some-other-org")).rejects.toThrow(
                NotFoundError,
            );
        });
    },
});
