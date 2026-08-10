import type { PreviewDeployGateResult } from "@autonoma/billing";
import { ApplicationArchitecture, type PreviewkitStatus } from "@autonoma/db";
import { ConflictError, InsufficientPreviewCreditsError, NotFoundError } from "@autonoma/errors";
import { expect, vi } from "vitest";
import { env } from "../../src/env";
import { PreviewkitTriggerService } from "../../src/previewkit/previewkit-trigger.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

const REPO_ID = 2001;
const REPO_FULL_NAME = "acme/web";

/** Stands in for a real BillingService in tests that don't exercise the credits gate. */
const allowingBillingService = {
    checkPreviewDeployCreditsGate: (): Promise<PreviewDeployGateResult> => Promise.resolve({ allowed: true }),
};

/** Flips both dual-gate switches on for the duration of `fn`, restoring both afterward. */
async function withBillingEnforced(
    harness: APITestHarness,
    organizationId: string,
    fn: () => Promise<void>,
): Promise<void> {
    const wasGloballyEnabled = env.PREVIEWKIT_BILLING_ENABLED;
    env.PREVIEWKIT_BILLING_ENABLED = true;
    await harness.db.organizationSettings.upsert({
        where: { organizationId },
        create: { organizationId, previewkitBillingEnabled: true },
        update: { previewkitBillingEnabled: true },
    });
    try {
        await fn();
    } finally {
        env.PREVIEWKIT_BILLING_ENABLED = wasGloballyEnabled;
        await harness.db.organizationSettings.upsert({
            where: { organizationId },
            create: { organizationId, previewkitBillingEnabled: false },
            update: { previewkitBillingEnabled: false },
        });
    }
}

/** Marks the application as deploying its own previews (Vercel and the like) for the duration of `fn`. */
async function withExternalDeploys(
    harness: APITestHarness,
    applicationId: string,
    fn: () => Promise<void>,
): Promise<void> {
    const previous = await harness.db.onboardingState.findUnique({
        where: { applicationId },
        select: { previewEnvironmentMode: true },
    });
    await harness.db.onboardingState.upsert({
        where: { applicationId },
        create: { applicationId, previewEnvironmentMode: "existing_deploys" },
        update: { previewEnvironmentMode: "existing_deploys" },
    });
    try {
        await fn();
    } finally {
        if (previous == null) {
            await harness.db.onboardingState.delete({ where: { applicationId } });
        } else {
            await harness.db.onboardingState.update({
                where: { applicationId },
                data: { previewEnvironmentMode: previous.previewEnvironmentMode },
            });
        }
    }
}

/** Flips the main-branch (PR-0) build kill switch off for the duration of `fn`, restoring it afterward. */
async function withMainBranchBuildsDisabled(fn: () => Promise<void>): Promise<void> {
    const previous = env.PREVIEWKIT_MAIN_BRANCH_BUILDS_ENABLED;
    env.PREVIEWKIT_MAIN_BRANCH_BUILDS_ENABLED = false;
    try {
        await fn();
    } finally {
        env.PREVIEWKIT_MAIN_BRANCH_BUILDS_ENABLED = previous;
    }
}

async function setCreditBalance(harness: APITestHarness, organizationId: string, creditBalance: number): Promise<void> {
    await harness.db.billingCustomer.upsert({
        where: { organizationId },
        create: { organizationId, creditBalance },
        update: { creditBalance },
    });
}

/**
 * A `PreviewkitTriggerService` wired to the REAL credit balance in the DB (not
 * `harness.services.previewkitTrigger`, which runs against `DisabledBillingService`
 * in tests since `STRIPE_ENABLED` is off - that no-ops the gate entirely). Mirrors
 * `checkPreviewDeployCreditsGate`'s own `balance <= 0` check; the gate's balance
 * arithmetic itself is covered separately in packages/billing/test/credits-preview-deploy-gate.test.ts -
 * this exercises the trigger-service orchestration (dual-gate read, comment, throw).
 */
function gateTestService(harness: APITestHarness): PreviewkitTriggerService {
    return new PreviewkitTriggerService(
        harness.db,
        harness.services.github,
        {
            checkPreviewDeployCreditsGate: async (organizationId: string) => {
                const customer = await harness.db.billingCustomer.findUnique({
                    where: { organizationId },
                    select: { creditBalance: true },
                });
                const balance = customer?.creditBalance ?? 0;
                return balance <= 0
                    ? { allowed: false as const, reason: "out_of_credits" as const }
                    : { allowed: true as const };
            },
        },
        harness.triggerWorkflow,
        harness.triggerWorkflow,
        harness.triggerWorkflow,
        harness.triggerWorkflow,
    );
}

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
        // This suite exercises the previewkit-hosted flow throughout, so the seeded app has made that onboarding
        // choice - an unmade choice (NULL) now means customer-deployed and would skip every run before it starts.
        await harness.db.onboardingState.upsert({
            where: { applicationId: app.id },
            create: { applicationId: app.id, previewEnvironmentMode: "previewkit" },
            update: { previewEnvironmentMode: "previewkit" },
        });

        await harness.services.github.handleInstallation(54321, harness.organizationId, {
            login: "acme",
            id: 777,
            type: "Organization",
            createdAt: new Date(),
        });

        return { app, service };
    },
    cases: (test) => {
        test("startRunFromPullRequestWebhook eagerly creates the PR branch and threads its id into the deploy target", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.triggerWorkflow.mockClear();

            await service.startRunFromPullRequestWebhook("synchronize", harness.organizationId, pullRequestPayload(7));

            // A snapshot-less branch is created before any diff runs.
            const branch = await harness.db.branch.findFirst({
                where: { applicationId: app.id, prInfo: { prNumber: 7 } },
                select: { id: true, name: true, snapshots: { select: { id: true } } },
            });
            expect(branch).not.toBeNull();
            expect(branch!.name).toBe("feature/pr-7");
            expect(branch!.snapshots).toHaveLength(0);

            // The run owns the build decision, so a resolved branch starts a run and no build is launched here.
            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
            expect(harness.startAnalysisRun).toHaveBeenCalledWith({
                branchId: branch!.id,
                headSha: "head-7",
                baseSha: "main-sha-2",
            });
        });

        test("startRunFromPullRequestWebhook reuses the same branch across pushes to the same PR", async ({
            harness,
            seedResult: { app, service },
        }) => {
            await service.startRunFromPullRequestWebhook("opened", harness.organizationId, pullRequestPayload(8));
            await service.startRunFromPullRequestWebhook("synchronize", harness.organizationId, pullRequestPayload(8));

            const branches = await harness.db.branch.findMany({
                where: { applicationId: app.id, prInfo: { prNumber: 8 } },
                select: { id: true },
            });
            expect(branches).toHaveLength(1);
        });

        test("startRunFromPullRequestWebhook deploys an un-onboarded repo with no branch link", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();

            const unlinkedRepoPayload: Record<string, unknown> = {
                pull_request: {
                    number: 30,
                    draft: false,
                    head: { sha: "head-30", ref: "feature/pr-30" },
                    base: { sha: "main-sha-2", ref: "main" },
                },
                repository: {
                    id: 9999,
                    full_name: "acme/unlinked",
                    clone_url: "https://github.com/acme/unlinked.git",
                },
            };

            await service.startRunFromPullRequestWebhook("opened", harness.organizationId, unlinkedRepoPayload);

            // No Application for this repo -> no branch created, deploy still fires unlinked. Scope to this
            // suite's org: the integration DB is shared across suites, so an unscoped count is not isolated.
            const branchCount = await harness.db.branch.count({
                where: { organizationId: harness.organizationId, prInfo: { prNumber: 30 } },
            });
            expect(branchCount).toBe(0);
            expect(harness.triggerWorkflow).toHaveBeenCalledTimes(1);
            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                target: expect.objectContaining({ prNumber: 30, repoFullName: "acme/unlinked" }),
                reason: "branch_not_resolvable",
            });
        });

        test("startRunFromPullRequestWebhook skips a draft PR when previewkitBuildDraft is disabled", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();

            await service.startRunFromPullRequestWebhook(
                "opened",
                harness.organizationId,
                pullRequestPayload(20, true),
            );

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("startRunFromPullRequestWebhook builds a draft PR when previewkitBuildDraft is enabled", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, previewkitBuildDraft: true },
                update: { previewkitBuildDraft: true },
            });

            harness.startAnalysisRun.mockClear();
            await service.startRunFromPullRequestWebhook(
                "opened",
                harness.organizationId,
                pullRequestPayload(21, true),
            );

            expect(harness.startAnalysisRun).toHaveBeenCalledTimes(1);

            await harness.db.organizationSettings.delete({ where: { organizationId: harness.organizationId } });
        });

        test("startRunFromPullRequestWebhook builds a ready-for-review PR even when previewkitBuildDraft is disabled", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();
            harness.startAnalysisRun.mockClear();

            // A PR marked ready for review is no longer a draft (draft: false),
            // so it deploys regardless of the org's draft-build setting.
            await service.startRunFromPullRequestWebhook(
                "ready_for_review",
                harness.organizationId,
                pullRequestPayload(22, false),
            );

            expect(harness.startAnalysisRun).toHaveBeenCalledTimes(1);
            expect(harness.startAnalysisRun).toHaveBeenCalledWith(expect.objectContaining({ headSha: "head-22" }));
        });

        test("startRunFromPullRequestWebhook skips an unparseable payload without triggering", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();

            await service.startRunFromPullRequestWebhook("opened", harness.organizationId, {
                repository: { id: REPO_ID },
            });

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("startRunFromPullRequestWebhook skips a repo the customer deploys previews for itself", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.triggerWorkflow.mockClear();
            harness.startAnalysisRun.mockClear();

            await withExternalDeploys(harness, app.id, async () => {
                await service.startRunFromPullRequestWebhook("opened", harness.organizationId, pullRequestPayload(41));
            });

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
            expect(harness.startAnalysisRun).not.toHaveBeenCalled();
        });

        test("teardownFromWebhook skips a repo the customer deploys previews for itself", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.triggerWorkflow.mockClear();

            await withExternalDeploys(harness, app.id, async () => {
                await service.teardownFromWebhook(harness.organizationId, pullRequestPayload(42));
            });

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
                repoFullName: REPO_FULL_NAME,
                prNumber: 9,
                organizationId: harness.organizationId,
                headSha: "head-9",
            });
        });

        test("startMainBranchRun resolves the branch head and deploys environment 0", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.triggerWorkflow.mockClear();

            const result = await service.startMainBranchRun(app.id, harness.organizationId);

            expect(result).toEqual({
                applicationId: app.id,
                repoFullName: REPO_FULL_NAME,
                branch: "main",
                headSha: "main-sha-2",
                prNumber: 0,
            });

            // The main-branch env (PR 0) is linked to the application's main Branch.
            const appRow = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranchId: true },
            });
            expect(appRow.mainBranchId).not.toBeNull();
            expect(harness.startAnalysisRun).toHaveBeenCalledWith({
                branchId: appRow.mainBranchId,
                headSha: "main-sha-2",
                baseSha: "main-sha-2",
            });
        });

        test("startMainBranchRun rejects an application outside the caller's org", async ({
            seedResult: { app, service },
        }) => {
            await expect(service.startMainBranchRun(app.id, "some-other-org")).rejects.toThrow(NotFoundError);
        });

        test("startMainBranchRun rejects a disabled application", async ({ harness, seedResult: { service } }) => {
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

            await expect(service.startMainBranchRun(disabledApp.id, harness.organizationId)).rejects.toThrow(
                ConflictError,
            );
        });

        test("startMainBranchRun rejects an application with no linked repository", async ({
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

            await expect(service.startMainBranchRun(unlinkedApp.id, harness.organizationId)).rejects.toThrow(
                ConflictError,
            );
        });

        test("startMainBranchRun rejects a suspended installation", async ({
            harness,
            seedResult: { app, service },
        }) => {
            await harness.db.gitHubInstallation.update({
                where: { organizationId: harness.organizationId },
                data: { status: "suspended" },
            });
            try {
                await expect(service.startMainBranchRun(app.id, harness.organizationId)).rejects.toThrow(
                    /GitHub installation is suspended/,
                );
            } finally {
                await harness.db.gitHubInstallation.update({
                    where: { organizationId: harness.organizationId },
                    data: { status: "active" },
                });
            }
        });

        test("startMainBranchRun maps GitHub 404s to NotFoundError", async ({ harness, seedResult: { app } }) => {
            const notFound = Object.assign(new Error("Not Found"), { status: 404 });
            const deploySpy = vi.fn().mockResolvedValue(undefined);

            const repoMissing = new PreviewkitTriggerService(
                harness.db,
                {
                    getRepository: () => Promise.reject(notFound),
                    getBranchHead: () => Promise.reject(notFound),
                    getPullRequest: () => Promise.reject(notFound),
                    postComment: () => Promise.reject(notFound),
                },
                allowingBillingService,
                deploySpy,
                deploySpy,
                deploySpy,
                deploySpy,
            );
            await expect(repoMissing.startMainBranchRun(app.id, harness.organizationId)).rejects.toThrow(
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
                    getPullRequest: () => Promise.reject(notFound),
                    postComment: () => Promise.reject(notFound),
                },
                allowingBillingService,
                deploySpy,
                deploySpy,
                deploySpy,
                deploySpy,
            );
            await expect(branchMissing.startMainBranchRun(app.id, harness.organizationId)).rejects.toThrow(
                /Deploy branch 'main' not found/,
            );
            expect(deploySpy).not.toHaveBeenCalled();
        });

        test("startMainBranchRun errors when the configured deploy branch is gone (no silent fallback)", async ({
            harness,
            seedResult: { app },
        }) => {
            // The configured branch (here an explicit "autonoma") that no longer
            // exists must error, never silently deploy the repo default instead - even
            // though the default would resolve.
            const appRow = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranchId: true },
            });
            const mainBranchId = appRow.mainBranchId;
            if (mainBranchId == null) throw new Error("seeded app has no main branch");
            await harness.db.branch.update({ where: { id: mainBranchId }, data: { name: "autonoma" } });
            await harness.db.mainBranchInfo.updateMany({
                where: { branchId: mainBranchId },
                data: { githubRef: "autonoma" },
            });

            const notFound = Object.assign(new Error("Not Found"), { status: 404 });
            const deploySpy = vi.fn().mockResolvedValue(undefined);
            const service = new PreviewkitTriggerService(
                harness.db,
                {
                    getRepository: () =>
                        Promise.resolve({
                            id: REPO_ID,
                            name: "web",
                            fullName: REPO_FULL_NAME,
                            defaultBranch: "master",
                            private: false,
                        }),
                    // The default "master" resolves; a fallback (if it existed) would use it.
                    getBranchHead: (_orgId: string, _repoId: number, branch: string) =>
                        branch === "master" ? Promise.resolve("main-sha-2") : Promise.reject(notFound),
                    getPullRequest: () => Promise.reject(notFound),
                    postComment: () => Promise.reject(notFound),
                },
                allowingBillingService,
                deploySpy,
                deploySpy,
                deploySpy,
                deploySpy,
            );

            await expect(service.startMainBranchRun(app.id, harness.organizationId)).rejects.toThrow(
                /Deploy branch 'autonoma' not found/,
            );
            expect(deploySpy).not.toHaveBeenCalled();
        });

        test("startMainBranchRun rejects when main-branch builds are disabled fleet-wide", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.startAnalysisRun.mockClear();

            await withMainBranchBuildsDisabled(async () => {
                await expect(service.startMainBranchRun(app.id, harness.organizationId)).rejects.toThrow(ConflictError);
            });

            expect(harness.startAnalysisRun).not.toHaveBeenCalled();
        });

        test("startMainBranchRunFromPushWebhook updates environment 0 on a push to the tracked branch", async ({
            harness,
            seedResult: { service },
        }) => {
            await setMainBranchEnvironment(harness, "main", "ready");
            harness.triggerWorkflow.mockClear();

            await service.startMainBranchRunFromPushWebhook(harness.organizationId, pushPayload("main", "push-sha-1"));

            const appRow = await harness.db.application.findFirstOrThrow({
                where: { organizationId: harness.organizationId, githubRepositoryId: REPO_ID },
                select: { mainBranchId: true },
            });
            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
            expect(harness.startAnalysisRun).toHaveBeenCalledWith({
                branchId: appRow.mainBranchId,
                headSha: "push-sha-1",
                baseSha: "push-sha-1",
            });
        });

        test("startMainBranchRunFromPushWebhook ignores a push to a branch the environment does not track", async ({
            harness,
            seedResult: { service },
        }) => {
            await setMainBranchEnvironment(harness, "main", "ready");
            harness.triggerWorkflow.mockClear();

            await service.startMainBranchRunFromPushWebhook(
                harness.organizationId,
                pushPayload("develop", "push-sha-2"),
            );

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("startMainBranchRunFromPushWebhook ignores a push when the environment is torn down", async ({
            harness,
            seedResult: { service },
        }) => {
            await setMainBranchEnvironment(harness, "main", "torn_down");
            harness.triggerWorkflow.mockClear();

            await service.startMainBranchRunFromPushWebhook(harness.organizationId, pushPayload("main", "push-sha-3"));

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("startMainBranchRunFromPushWebhook ignores a repo without a main-branch environment", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();
            harness.startAnalysisRun.mockClear();
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

            await service.startMainBranchRunFromPushWebhook(harness.organizationId, unrelatedRepoPush);

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
            expect(harness.startAnalysisRun).not.toHaveBeenCalled();
        });

        test("startMainBranchRunFromPushWebhook ignores branch deletions, zero-sha pushes and tag pushes", async ({
            harness,
            seedResult: { service },
        }) => {
            await setMainBranchEnvironment(harness, "main", "ready");
            harness.triggerWorkflow.mockClear();

            await service.startMainBranchRunFromPushWebhook(
                harness.organizationId,
                pushPayload("main", "push-sha-5", true),
            );
            await service.startMainBranchRunFromPushWebhook(
                harness.organizationId,
                pushPayload("main", "0".repeat(40)),
            );
            await service.startMainBranchRunFromPushWebhook(harness.organizationId, {
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

        test("startMainBranchRunFromPushWebhook scopes to the webhook's organization", async ({
            harness,
            seedResult: { service },
        }) => {
            await setMainBranchEnvironment(harness, "main", "ready");
            harness.triggerWorkflow.mockClear();

            await service.startMainBranchRunFromPushWebhook("some-other-org", pushPayload("main", "push-sha-7"));

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("startMainBranchRunFromPushWebhook skips an unparseable payload without triggering", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();

            await service.startMainBranchRunFromPushWebhook(harness.organizationId, { ref: "refs/heads/main" });

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("startMainBranchRunFromPushWebhook no-ops when main-branch builds are disabled fleet-wide", async ({
            harness,
            seedResult: { service },
        }) => {
            await setMainBranchEnvironment(harness, "main", "ready");
            harness.triggerWorkflow.mockClear();
            harness.startAnalysisRun.mockClear();

            await withMainBranchBuildsDisabled(async () => {
                await service.startMainBranchRunFromPushWebhook(
                    harness.organizationId,
                    pushPayload("main", "push-sha-8"),
                );
            });

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
            expect(harness.startAnalysisRun).not.toHaveBeenCalled();
        });

        test("startRunForPullRequest builds the PR itself instead of letting a run decide", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.triggerWorkflow.mockClear();
            harness.startAnalysisRun.mockClear();
            harness.githubApp.defaultClient.addPullRequest(REPO_FULL_NAME, {
                number: 61,
                title: "Add the Autonoma SDK handler",
                headRef: "feature/pr-61",
                baseSha: "main-sha-2",
                commits: ["pr-61-head"],
            });

            await service.startRunForPullRequest(harness.organizationId, REPO_ID, 61);

            const branch = await harness.db.branch.findFirst({
                where: { applicationId: app.id, prInfo: { prNumber: 61 } },
                select: { id: true },
            });
            expect(branch).not.toBeNull();

            // An application with no test suite selects no tests, so a run would refuse the build outright.
            expect(harness.startAnalysisRun).not.toHaveBeenCalled();
            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                target: {
                    prNumber: 61,
                    repoFullName: REPO_FULL_NAME,
                    organizationId: harness.organizationId,
                    githubRepositoryId: REPO_ID,
                    headSha: "pr-61-head",
                    headRef: "feature/pr-61",
                    branchId: branch!.id,
                },
                reason: "force_build",
                branchId: branch!.id,
            });
        });

        test("startRunForPullRequest refuses a closed pull request", async ({ harness, seedResult: { service } }) => {
            harness.githubApp.defaultClient.addPullRequest(REPO_FULL_NAME, {
                number: 62,
                title: "Already merged",
                headRef: "feature/pr-62",
                baseSha: "main-sha-2",
                commits: ["pr-62-head"],
                state: "closed",
            });

            await expect(service.startRunForPullRequest(harness.organizationId, REPO_ID, 62)).rejects.toThrow(
                ConflictError,
            );
        });

        test("redeploy first-deploys a PR that has no environment yet", async ({
            harness,
            seedResult: { service },
        }) => {
            // The repository id comes from the organization's other environment for the same repo.
            await setMainBranchEnvironment(harness, "main", "ready");
            harness.triggerWorkflow.mockClear();
            harness.startAnalysisRun.mockClear();
            harness.githubApp.defaultClient.addPullRequest(REPO_FULL_NAME, {
                number: 63,
                title: "No environment yet",
                headRef: "feature/pr-63",
                baseSha: "main-sha-2",
                commits: ["pr-63-head"],
            });

            await service.startRunForRedeploy(
                { repoFullName: REPO_FULL_NAME, prNumber: 63 },
                { organizationId: harness.organizationId },
            );

            expect(harness.startAnalysisRun).not.toHaveBeenCalled();
            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                target: expect.objectContaining({
                    prNumber: 63,
                    repoFullName: REPO_FULL_NAME,
                    headSha: "pr-63-head",
                    headRef: "feature/pr-63",
                }),
                reason: "force_build",
                branchId: expect.any(String),
            });
        });

        test("redeploy reports not found when the organization has no environment for the repo", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();

            await expect(
                service.startRunForRedeploy(
                    { repoFullName: "acme/never-deployed", prNumber: 64 },
                    { organizationId: harness.organizationId },
                ),
            ).rejects.toThrow(NotFoundError);
            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("redeploy falls back to the stored head when GitHub can't resolve the PR", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();
            // PR 12 is deliberately NOT registered on the fake GitHub client,
            // so the latest-head lookup fails and the stored head is used.
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-12",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 12,
                    headSha: "head-12",
                    headRef: "feature/pr-12",
                    githubRepositoryId: REPO_ID,
                    status: "ready",
                    organizationId: harness.organizationId,
                },
            });

            await service.startRunForRedeploy(
                { repoFullName: REPO_FULL_NAME, prNumber: 12 },
                { organizationId: harness.organizationId },
            );

            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                target: {
                    prNumber: 12,
                    repoFullName: REPO_FULL_NAME,
                    organizationId: harness.organizationId,
                    githubRepositoryId: REPO_ID,
                    headSha: "head-12",
                    headRef: "feature/pr-12",
                },
                reason: "force_build",
            });
        });

        test("redeploy resolves the PR's latest head from GitHub over the stored one", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();
            harness.githubApp.defaultClient.addPullRequest(REPO_FULL_NAME, {
                number: 15,
                title: "Feature PR",
                headRef: "feature/pr-15",
                baseSha: "main-sha-2",
                commits: ["pr-15-old-head", "pr-15-new-head"],
            });
            // The stored head is one commit behind the PR's current head.
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-15",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 15,
                    headSha: "pr-15-old-head",
                    headRef: "feature/pr-15",
                    githubRepositoryId: REPO_ID,
                    status: "ready",
                    organizationId: harness.organizationId,
                },
            });

            await service.startRunForRedeploy(
                { repoFullName: REPO_FULL_NAME, prNumber: 15 },
                { organizationId: harness.organizationId },
            );

            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                target: {
                    prNumber: 15,
                    repoFullName: REPO_FULL_NAME,
                    organizationId: harness.organizationId,
                    githubRepositoryId: REPO_ID,
                    headSha: "pr-15-new-head",
                    headRef: "feature/pr-15",
                },
                reason: "force_build",
            });
        });

        test("redeploy of the main-branch environment resolves the tracked branch's latest head", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.triggerWorkflow.mockClear();
            // Stored at main-sha-1 while the fake repo's main branch has advanced to main-sha-2.
            await setMainBranchEnvironment(harness, "main", "ready");

            await service.startRunForRedeploy(
                { repoFullName: REPO_FULL_NAME, prNumber: 0 },
                { organizationId: harness.organizationId },
            );

            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                target: {
                    prNumber: 0,
                    repoFullName: REPO_FULL_NAME,
                    organizationId: harness.organizationId,
                    githubRepositoryId: REPO_ID,
                    headSha: "main-sha-2",
                    headRef: "main",
                },
                reason: "force_build",
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

            await expect(
                service.startRunForRedeploy(
                    { repoFullName: REPO_FULL_NAME, prNumber: 13 },
                    { organizationId: harness.organizationId },
                ),
            ).rejects.toThrow(ConflictError);
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

            await expect(
                service.startRunForRedeploy(
                    { repoFullName: REPO_FULL_NAME, prNumber: 14 },
                    { organizationId: "some-other-org" },
                ),
            ).rejects.toThrow(NotFoundError);
        });

        test("redeployApp reconstructs the target, namespace, app + mode", async ({
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
                    organizationId: harness.organizationId,
                    appInstances: { create: [{ appName: "web", status: "ready", port: 3000 }] },
                },
            });

            await service.redeployApp({ repoFullName: REPO_FULL_NAME, prNumber: 20 }, "web", "rebuild", {
                organizationId: harness.organizationId,
            });

            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                target: {
                    prNumber: 20,
                    repoFullName: REPO_FULL_NAME,
                    organizationId: harness.organizationId,
                    githubRepositoryId: REPO_ID,
                    headSha: "head-20",
                    headRef: "feature/pr-20",
                },
                namespace: "preview-acme-web-pr-20",
                appName: "web",
                mode: "rebuild",
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

            await service.redeployApp({ repoFullName: REPO_FULL_NAME, prNumber: 21 }, "web", "restart", {
                organizationId: harness.organizationId,
            });

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
                service.redeployApp({ repoFullName: REPO_FULL_NAME, prNumber: 22 }, "api", "rebuild", {
                    organizationId: harness.organizationId,
                }),
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
                service.redeployApp({ repoFullName: REPO_FULL_NAME, prNumber: 23 }, "web", "rebuild", {
                    organizationId: harness.organizationId,
                }),
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

            await expect(
                service.redeployApp({ repoFullName: REPO_FULL_NAME, prNumber: 24 }, "web", "rebuild", {
                    organizationId: "some-other-org",
                }),
            ).rejects.toThrow(NotFoundError);
        });

        test("deploy is blocked and comments on the PR when the org is out of credits and both gates are on", async ({
            harness,
        }) => {
            const service = gateTestService(harness);
            harness.triggerWorkflow.mockClear();
            harness.githubApp.defaultClient.comments.length = 0;
            await setCreditBalance(harness, harness.organizationId, 0);

            await withBillingEnforced(harness, harness.organizationId, async () => {
                await expect(
                    service.startRunFromPullRequestWebhook("opened", harness.organizationId, pullRequestPayload(40)),
                ).rejects.toThrow(InsufficientPreviewCreditsError);
            });

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
            expect(harness.githubApp.defaultClient.comments).toHaveLength(1);
            expect(harness.githubApp.defaultClient.comments[0]).toMatchObject({
                repoFullName: REPO_FULL_NAME,
                prNumber: 40,
            });
        });

        test("deploy proceeds once the org has a positive balance", async ({ harness }) => {
            const service = gateTestService(harness);
            harness.triggerWorkflow.mockClear();
            await setCreditBalance(harness, harness.organizationId, 1_000);

            await withBillingEnforced(harness, harness.organizationId, async () => {
                await service.startRunFromPullRequestWebhook("opened", harness.organizationId, pullRequestPayload(41));
            });

            expect(harness.triggerWorkflow).toHaveBeenCalledTimes(1);
        });

        test("deploy is not blocked when the global PREVIEWKIT_BILLING_ENABLED switch is off", async ({ harness }) => {
            const service = gateTestService(harness);
            harness.triggerWorkflow.mockClear();
            // Zero balance, org setting on, but the global switch stays off (default) - not enforced.
            await setCreditBalance(harness, harness.organizationId, 0);
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, previewkitBillingEnabled: true },
                update: { previewkitBillingEnabled: true },
            });

            try {
                await service.startRunFromPullRequestWebhook("opened", harness.organizationId, pullRequestPayload(42));
                expect(harness.triggerWorkflow).toHaveBeenCalledTimes(1);
            } finally {
                await harness.db.organizationSettings.upsert({
                    where: { organizationId: harness.organizationId },
                    create: { organizationId: harness.organizationId, previewkitBillingEnabled: false },
                    update: { previewkitBillingEnabled: false },
                });
            }
        });

        test("deploy is not blocked when the org's own previewkitBillingEnabled setting is off", async ({
            harness,
        }) => {
            const service = gateTestService(harness);
            harness.triggerWorkflow.mockClear();
            // Zero balance, global switch on, but the org never opted in - not enforced.
            await setCreditBalance(harness, harness.organizationId, 0);
            const wasGloballyEnabled = env.PREVIEWKIT_BILLING_ENABLED;
            env.PREVIEWKIT_BILLING_ENABLED = true;
            try {
                await service.startRunFromPullRequestWebhook("opened", harness.organizationId, pullRequestPayload(43));
                expect(harness.triggerWorkflow).toHaveBeenCalledTimes(1);
            } finally {
                env.PREVIEWKIT_BILLING_ENABLED = wasGloballyEnabled;
            }
        });

        test("redeployApp is blocked the same way as deploy when the org is out of credits", async ({ harness }) => {
            const service = gateTestService(harness);
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-44",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 44,
                    headSha: "head-44",
                    headRef: "feature/pr-44",
                    githubRepositoryId: REPO_ID,
                    status: "ready",
                    organizationId: harness.organizationId,
                    appInstances: { create: [{ appName: "web", status: "ready", port: 3000 }] },
                },
            });
            harness.triggerWorkflow.mockClear();
            await setCreditBalance(harness, harness.organizationId, 0);

            await withBillingEnforced(harness, harness.organizationId, async () => {
                await expect(
                    service.redeployApp({ repoFullName: REPO_FULL_NAME, prNumber: 44 }, "web", "rebuild", {
                        organizationId: harness.organizationId,
                    }),
                ).rejects.toThrow(InsufficientPreviewCreditsError);
            });

            expect(harness.triggerWorkflow).not.toHaveBeenCalled();
        });

        test("teardown is never blocked by the credits gate, even when out of credits", async ({ harness }) => {
            const service = gateTestService(harness);
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-acme-web-pr-45",
                    repoFullName: REPO_FULL_NAME,
                    prNumber: 45,
                    headSha: "head-45",
                    headRef: "feature/pr-45",
                    githubRepositoryId: REPO_ID,
                    status: "ready",
                    organizationId: harness.organizationId,
                },
            });
            harness.triggerWorkflow.mockClear();
            await setCreditBalance(harness, harness.organizationId, 0);

            await withBillingEnforced(harness, harness.organizationId, async () => {
                await service.teardownFromWebhook(harness.organizationId, pullRequestPayload(45));
            });

            expect(harness.triggerWorkflow).toHaveBeenCalledTimes(1);
        });
    },
});
