import type { PrismaClient } from "@autonoma/db";
import { ApplicationArchitecture, TriggerSource } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { AddTest, TestSuiteUpdater } from "@autonoma/test-updates";
import { expect } from "vitest";
import type { DiffsTriggerService } from "../../src/diffs/diffs-trigger.service";
import { PreviewAnalysisRunTrigger } from "../../src/github/analysis-run-trigger";
import { apiTestSuite } from "../api-test";

/** Captures the URL each requested run is seeded from, so a test can assert which preview URL was resolved. */
class CapturingPrDiffsTrigger implements Pick<DiffsTriggerService, "triggerPrDiffs"> {
    public urls: string[] = [];
    constructor(private readonly skipped = false) {}

    async triggerPrDiffs(
        params: Parameters<DiffsTriggerService["triggerPrDiffs"]>[0],
    ): ReturnType<DiffsTriggerService["triggerPrDiffs"]> {
        this.urls.push(params.url);
        if (this.skipped) return { branchId: "branch", skipped: true };
        return { branchId: "branch", snapshotId: "snapshot", deploymentId: "deployment" };
    }
}

async function setActiveSnapshotHeadSha(db: PrismaClient, branchId: string, headSha: string): Promise<void> {
    const branch = await db.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: { activeSnapshotId: true },
    });
    if (branch.activeSnapshotId == null) {
        throw new Error(`Branch ${branchId} has no active snapshot to update`);
    }
    await db.branchSnapshot.update({
        where: { id: branch.activeSnapshotId },
        data: { headSha },
    });
}

/**
 * Pre-create the PR branch with its own active snapshot carrying one pinned-plan assignment, so a subsequent
 * triggerPrDiffs forks both the diffs snapshot and the investigation twin from that baseline. Self-contained
 * (no shared main branch) so it does not collide with other tests in the shared-DB suite.
 */
async function setupBranchWithBaseline(
    db: PrismaClient,
    organizationId: string,
    applicationId: string,
    prNumber: number,
    headRef: string,
): Promise<{ branchId: string; testCaseId: string }> {
    const branch = await db.branch.create({
        data: { name: headRef, applicationId, organizationId, prInfo: { create: { applicationId, prNumber } } },
    });
    const folder = await db.folder.create({ data: { name: `flow-${prNumber}`, applicationId, organizationId } });
    const testCase = await db.testCase.create({
        data: { name: `tc-${prNumber}`, slug: `tc-${prNumber}`, applicationId, organizationId, folderId: folder.id },
    });
    const plan = await db.testPlan.create({
        data: { testCaseId: testCase.id, prompt: "Open homepage", organizationId },
    });
    const activeSnapshot = await db.branchSnapshot.create({
        data: { branchId: branch.id, status: "active", source: TriggerSource.WEBHOOK, headSha: `base-${prNumber}` },
    });
    await db.testCaseAssignment.create({
        data: { snapshotId: activeSnapshot.id, testCaseId: testCase.id, planId: plan.id },
    });
    await db.branch.update({ where: { id: branch.id }, data: { activeSnapshotId: activeSnapshot.id } });
    return { branchId: branch.id, testCaseId: testCase.id };
}

apiTestSuite({
    name: "DiffsTriggerService",
    seed: async ({ harness }) => {
        const service = harness.services.diffsTrigger;
        const fakeClient = harness.githubApp.defaultClient;

        fakeClient.addRepository({
            id: 1001,
            name: "my-repo",
            fullName: "org/my-repo",
            defaultBranch: "main",
            commits: ["initial-sha"],
        });

        for (const prNum of [10, 20, 30, 40, 50, 60, 70]) {
            fakeClient.addPullRequest("org/my-repo", {
                number: prNum,
                title: `Test PR #${prNum}`,
                headRef: `feature/branch-${prNum}`,
                baseSha: "initial-sha",
                commits: [`head-sha-${prNum}`],
            });
        }

        const app = await harness.services.applications.createApplication({
            name: "Test App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/file.png",
        });

        await harness.db.application.update({
            where: { id: app.id },
            data: { githubRepositoryId: 1001 },
        });

        // Distinct installation id per suite: the integration suites share one DB with no
        // per-suite truncation, and installation_id is globally unique, so reusing the same id
        // across suites collides on the shared table when files run concurrently.
        await harness.services.github.handleInstallation(
            33333,
            harness.organizationId,
            "test-org",
            999,
            "Organization",
        );

        return { app, service };
    },
    cases: (test) => {
        test("triggers diffs for a new branch", async ({ harness, seedResult: { app, service } }) => {
            const result = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 10,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
                webhookHeaders: { "X-Auth": "secret" },
            });

            expect(result.branchId).toBeDefined();
            expect(result.snapshotId).toBeDefined();
            expect(result.deploymentId).toBeDefined();

            const branch = await harness.db.branch.findUnique({
                where: { id: result.branchId },
                include: { prInfo: true },
            });
            expect(branch).not.toBeNull();
            expect(branch!.name).toBe("feature/branch-10");
            expect(branch!.prInfo?.prNumber).toBe(10);
            expect(branch!.applicationId).toBe(app.id);
            expect(branch!.deploymentId).toBe(result.deploymentId);
            // The trigger creates a pending snapshot but does not activate it; the branch
            // should have no active snapshot yet for this brand-new feature branch.
            expect(branch!.activeSnapshotId).toBeNull();
            expect(branch!.pendingSnapshotId).toBe(result.snapshotId);

            const deployment = await harness.db.branchDeployment.findUniqueOrThrow({
                where: { id: result.deploymentId },
                include: { webDeployment: true },
            });
            expect(deployment.webhookUrl).toBe("https://webhook.example.com/hook");
            expect(deployment.webhookHeaders).toEqual({ "X-Auth": "secret" });
            expect(deployment.webDeployment!.url).toBe("https://preview.example.com");

            expect(harness.triggerAnalysis).toHaveBeenCalledWith({ snapshotId: result.snapshotId });
        });

        test("activation suppresses an automatic run but honors an explicitly requested one", async ({
            harness,
            seedResult: { service },
        }) => {
            harness.githubApp.defaultClient.addPullRequest("org/my-repo", {
                number: 80,
                title: "Test PR #80",
                headRef: "feature/branch-80",
                baseSha: "initial-sha",
                commits: ["head-sha-80"],
            });
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, activationEnabled: true },
                update: { activationEnabled: true },
            });

            // Automatic caller (no `requested`): suppressed under activation - no snapshot, no run.
            const automatic = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 80,
                url: "https://preview.example.com",
            });
            // Explicitly requested (a merge-gate trigger): bypasses the gate and runs.
            const requested = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 80,
                url: "https://preview.example.com",
                requested: true,
            });

            // Reset before asserting so a failure can't leak activation to the other shared-org tests.
            await harness.db.organizationSettings.update({
                where: { organizationId: harness.organizationId },
                data: { activationEnabled: false },
            });

            expect(automatic.skipped).toBe(true);
            expect(automatic.snapshotId).toBeUndefined();
            expect(requested.skipped).toBeUndefined();
            expect(requested.snapshotId).toBeDefined();
        });

        test("PreviewAnalysisRunTrigger seeds the run from the primary app's preview URL", async ({ harness }) => {
            const diffsTrigger = new CapturingPrDiffsTrigger();
            const trigger = new PreviewAnalysisRunTrigger(harness.db, diffsTrigger);
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: "preview-org-primary-pr-90",
                    repoFullName: "org/preview-primary",
                    prNumber: 90,
                    headSha: "head-90",
                    headRef: "feature/primary",
                    organizationId: harness.organizationId,
                    status: "ready",
                    urls: { "app-a": "https://a.example.com", "app-b": "https://b.example.com" },
                    resolvedConfig: { apps: [{ name: "app-a" }, { name: "app-b", primary: true }] },
                },
            });

            const outcome = await trigger.requestRun({
                organizationId: harness.organizationId,
                repoFullName: "org/preview-primary",
                githubRepositoryId: 2090,
                prNumber: 90,
            });

            expect(outcome).toEqual({ started: true });
            expect(diffsTrigger.urls).toEqual(["https://b.example.com"]);
        });

        test("PreviewAnalysisRunTrigger reports no_preview when the PR has no live preview", async ({ harness }) => {
            const diffsTrigger = new CapturingPrDiffsTrigger();
            const trigger = new PreviewAnalysisRunTrigger(harness.db, diffsTrigger);

            const outcome = await trigger.requestRun({
                organizationId: harness.organizationId,
                repoFullName: "org/never-deployed",
                githubRepositoryId: 2091,
                prNumber: 91,
            });

            expect(outcome).toEqual({ started: false, reason: "no_preview" });
            expect(diffsTrigger.urls).toHaveLength(0);
        });

        test("triggers diffs for an existing branch", async ({ harness, seedResult: { app, service } }) => {
            const existingBranch = await harness.db.branch.create({
                data: {
                    name: "feature/branch-20",
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    prInfo: { create: { applicationId: app.id, prNumber: 20 } },
                },
            });

            const result = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 20,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.branchId).toBe(existingBranch.id);

            const branch = await harness.db.branch.findUnique({ where: { id: result.branchId } });
            // The trigger creates a pending snapshot but does not activate it.
            expect(branch!.activeSnapshotId).toBeNull();
            expect(branch!.pendingSnapshotId).toBe(result.snapshotId);
        });

        test("uses active snapshot's headSha as baseSha when available", async ({
            harness,
            seedResult: { app, service },
        }) => {
            const branchId = (
                await harness.db.branch.create({
                    data: {
                        name: "feature/branch-30",
                        applicationId: app.id,
                        organizationId: harness.organizationId,
                        prInfo: { create: { applicationId: app.id, prNumber: 30 } },
                    },
                    select: { id: true },
                })
            ).id;
            const activeSnapshot = await harness.db.branchSnapshot.create({
                data: {
                    branchId,
                    status: "active",
                    source: TriggerSource.WEBHOOK,
                    headSha: "previous-sha-999",
                },
                select: { id: true },
            });
            await harness.db.branch.update({
                where: { id: branchId },
                data: { activeSnapshotId: activeSnapshot.id },
            });

            const result = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 30,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            const snapshot = await harness.db.branchSnapshot.findUnique({ where: { id: result.snapshotId } });
            expect(snapshot!.baseSha).toBe("previous-sha-999");
        });

        test("skips PR diffs when the head was already analyzed (re-delivered webhook)", async ({
            harness,
            seedResult: { app, service },
        }) => {
            const branchId = (
                await harness.db.branch.create({
                    data: {
                        name: "feature/branch-60",
                        applicationId: app.id,
                        organizationId: harness.organizationId,
                        prInfo: { create: { applicationId: app.id, prNumber: 60 } },
                    },
                    select: { id: true },
                })
            ).id;
            // Active snapshot head equals PR 60's head ("head-sha-60"), so a fresh
            // signal for the same head has nothing new to diff.
            const activeSnapshot = await harness.db.branchSnapshot.create({
                data: { branchId, status: "active", source: TriggerSource.WEBHOOK, headSha: "head-sha-60" },
                select: { id: true },
            });
            await harness.db.branch.update({
                where: { id: branchId },
                data: { activeSnapshotId: activeSnapshot.id },
            });

            const result = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 60,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.skipped).toBe(true);
            expect(result.snapshotId).toBeUndefined();
            // No new snapshot beyond the pre-existing active one.
            const snapshots = await harness.db.branchSnapshot.findMany({ where: { branchId } });
            expect(snapshots).toHaveLength(1);
        });

        test("handles pending snapshot conflict", async ({ harness, seedResult: { service } }) => {
            const first = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 40,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            const second = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 40,
                url: "https://preview-v2.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(second.branchId).toBe(first.branchId);
            expect(second.snapshotId).not.toBe(first.snapshotId);

            // The old snapshot is preserved for observability, marked cancelled
            const oldSnapshot = await harness.db.branchSnapshot.findUnique({ where: { id: first.snapshotId } });
            expect(oldSnapshot).not.toBeNull();
            expect(oldSnapshot!.status).toBe("cancelled");

            // Its AnalysisJob is marked failed with a superseded reason
            const oldJob = await harness.db.analysisJob.findUnique({ where: { snapshotId: first.snapshotId } });
            expect(oldJob!.status).toBe("failed");
            expect(oldJob!.failureReason).toBe("Superseded by a newer analysis request");

            // The new snapshot should be processing
            const newSnapshot = await harness.db.branchSnapshot.findUnique({ where: { id: second.snapshotId } });
            expect(newSnapshot).not.toBeNull();
            expect(newSnapshot!.status).toBe("processing");

            // The cancelled snapshot is hidden from the user-facing history list...
            const history = await harness.services.branches.listSnapshots(second.branchId, harness.organizationId);
            expect(history.map((s) => s.id)).not.toContain(first.snapshotId);
            expect(history.map((s) => s.id)).toContain(second.snapshotId);

            // ...but still reachable directly by id (URL access preserved).
            const detail = await harness.services.branches.getSnapshotDetail(first.snapshotId, harness.organizationId);
            expect(detail.snapshot.id).toBe(first.snapshotId);
            expect(detail.snapshot.status).toBe("cancelled");

            // The stale run was cancelled by id, and the fresh analysis run started on the new snapshot.
            expect(harness.triggerWorkflow).toHaveBeenCalledWith(first.snapshotId);
            expect(harness.triggerAnalysis).toHaveBeenCalledWith({ snapshotId: second.snapshotId });
        });

        test("throws NotFoundError when no application linked to repo", async ({
            harness,
            seedResult: { service },
        }) => {
            await expect(
                service.triggerPrDiffs({
                    organizationId: harness.organizationId,
                    repoId: 9999,
                    prNumber: 50,
                    url: "https://preview.example.com",
                    webhookUrl: "https://webhook.example.com/hook",
                }),
            ).rejects.toThrow(NotFoundError);
        });

        test("inherits test case assignments from main branch on a new PR branch", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.addPullRequest("org/my-repo", {
                number: 80,
                title: "Test PR #80",
                headRef: "feature/branch-80",
                baseSha: "initial-sha",
                commits: ["head-sha-80"],
            });

            const mainBranch = await harness.db.branch.findFirstOrThrow({
                where: { id: app.mainBranchId! },
                select: { id: true, applicationId: true },
            });
            const folder = await harness.db.folder.create({
                data: {
                    name: "inherited",
                    applicationId: mainBranch.applicationId,
                    organizationId: harness.organizationId,
                },
            });

            const mainUpdater = await TestSuiteUpdater.startUpdate({ db: harness.db, branchId: mainBranch.id });
            const { testCaseId: inheritedTestCaseId } = await mainUpdater.apply(
                new AddTest({
                    folderId: folder.id,
                    name: "Diffs inherited test",
                    description: "Inherited by PR branches",
                    plan: "Open homepage",
                }),
            );
            // Discard pending generations queued by AddTest so the snapshot can finalize -
            // this test only verifies inheritance, not generation execution.
            for (const g of await mainUpdater.getPendingGenerations()) {
                await mainUpdater.discardGeneration(g.testGenerationId);
            }
            await mainUpdater.finalize();

            const result = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 80,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            const testAssignments = await harness.db.testCaseAssignment.findMany({
                where: { snapshotId: result.snapshotId },
                select: { testCaseId: true },
            });
            expect(testAssignments).toHaveLength(1);
            expect(testAssignments[0]!.testCaseId).toBe(inheritedTestCaseId);
        });

        test("triggerDiffs dispatches to PR flow when ref is not main and prNumber is set", async ({
            harness,
            seedResult: { service },
        }) => {
            const result = await service.triggerDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 50,
                githubRef: "feature/branch-50",
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: result.branchId },
                include: { prInfo: true },
            });
            expect(branch.prInfo?.prNumber).toBe(50);
        });

        test("triggers diffs for the main branch", async ({ harness, seedResult: { app, service } }) => {
            harness.githubApp.defaultClient.pushCommit("org/my-repo", "main", "main-head-sha-1");
            await setActiveSnapshotHeadSha(harness.db, app.mainBranchId!, "previous-main-sha");

            const result = await service.triggerMainDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.branchId).toBe(app.mainBranchId);

            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: result.snapshotId },
            });
            expect(snapshot.branchId).toBe(app.mainBranchId);
            expect(snapshot.headSha).toBe("main-head-sha-1");
            expect(snapshot.baseSha).toBe("previous-main-sha");

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: result.branchId },
                include: { mainInfo: true, prInfo: true },
            });
            expect(branch.mainInfo).not.toBeNull();
            expect(branch.prInfo).toBeNull();

            expect(harness.triggerAnalysis).toHaveBeenCalledWith({ snapshotId: result.snapshotId });
        });

        test("activation does not suppress a main-branch baseline run", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.pushCommit("org/my-repo", "main", "main-head-activation");
            await setActiveSnapshotHeadSha(harness.db, app.mainBranchId!, "previous-main-activation");
            await harness.db.organizationSettings.upsert({
                where: { organizationId: harness.organizationId },
                create: { organizationId: harness.organizationId, activationEnabled: true },
                update: { activationEnabled: true },
            });

            const result = await service.triggerMainDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                url: "https://preview.example.com",
            });

            // Reset before asserting so a failure can't leak activation to the other shared-org tests.
            await harness.db.organizationSettings.update({
                where: { organizationId: harness.organizationId },
                data: { activationEnabled: false },
            });

            // Activation only gates automatic PR runs; the baseline must keep updating on main pushes.
            expect(result.skipped).toBeUndefined();
            expect(result.snapshotId).toBeDefined();
        });

        test("skips main diffs when the head already matches the active snapshot", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.pushCommit("org/my-repo", "main", "unchanged-main-sha");
            await setActiveSnapshotHeadSha(harness.db, app.mainBranchId!, "unchanged-main-sha");
            const before = await harness.db.branchSnapshot.count({ where: { branchId: app.mainBranchId! } });

            const result = await service.triggerMainDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.skipped).toBe(true);
            expect(result.snapshotId).toBeUndefined();
            // No new snapshot was created for the unchanged head.
            const after = await harness.db.branchSnapshot.count({ where: { branchId: app.mainBranchId! } });
            expect(after).toBe(before);
        });

        test("triggerDiffs dispatches to main flow when ref matches main branch", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.pushCommit("org/my-repo", "main", "dispatcher-main-sha");
            await setActiveSnapshotHeadSha(harness.db, app.mainBranchId!, "dispatcher-base-sha");

            const result = await service.triggerDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                githubRef: "main",
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.branchId).toBe(app.mainBranchId);
            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: result.snapshotId },
            });
            expect(snapshot.headSha).toBe("dispatcher-main-sha");
            expect(snapshot.baseSha).toBe("dispatcher-base-sha");
        });

        test("triggerDiffs dispatches to main flow when ref matches main even if prNumber is set", async ({
            harness,
            seedResult: { app, service },
        }) => {
            harness.githubApp.defaultClient.pushCommit("org/my-repo", "main", "main-wins-sha");
            await setActiveSnapshotHeadSha(harness.db, app.mainBranchId!, "main-wins-base-sha");

            const result = await service.triggerDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 60,
                githubRef: "main",
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.branchId).toBe(app.mainBranchId);
            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: result.branchId },
                include: { mainInfo: true, prInfo: true },
            });
            expect(branch.mainInfo).not.toBeNull();
            expect(branch.prInfo).toBeNull();
        });

        test("triggerDiffs throws BadRequestError for unknown ref", async ({ harness, seedResult: { service } }) => {
            await expect(
                service.triggerDiffs({
                    organizationId: harness.organizationId,
                    repoId: 1001,
                    githubRef: "feature/random",
                    url: "https://preview.example.com",
                    webhookUrl: "https://webhook.example.com/hook",
                }),
            ).rejects.toThrow(BadRequestError);
        });

        test("main branch trigger throws when no application linked to repo", async ({
            harness,
            seedResult: { service },
        }) => {
            await expect(
                service.triggerMainDiffs({
                    organizationId: harness.organizationId,
                    repoId: 9999,
                    url: "https://preview.example.com",
                    webhookUrl: "https://webhook.example.com/hook",
                }),
            ).rejects.toThrow(NotFoundError);
        });

        test("throws NotFoundError when no GitHub installation", async ({ harness, seedResult: { service } }) => {
            await harness.db.gitHubInstallation.deleteMany({
                where: { organizationId: harness.organizationId },
            });

            await expect(
                service.triggerPrDiffs({
                    organizationId: harness.organizationId,
                    repoId: 1001,
                    prNumber: 60,
                    url: "https://preview.example.com",
                    webhookUrl: "https://webhook.example.com/hook",
                }),
            ).rejects.toThrow(NotFoundError);
        });

        // Nothing creates investigation twins any more, but the ones already in the database must keep rendering:
        // their report hangs off the twin and has to resolve from the PR snapshot id via the pairing FK, and the
        // twin has to stay hidden from user-facing history. Both are read paths over pre-cutover rows.
        test("resolves a paired investigation report from the PR snapshot, and keeps the twin out of history", async ({
            harness,
            seedResult: { app, service },
        }) => {
            // An earlier test in this shared-DB suite deletes the installation; restore it (upsert by org).
            await harness.services.github.handleInstallation(
                33333,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await setupBranchWithBaseline(harness.db, harness.organizationId, app.id, 70, "feature/branch-70");

            const result = await service.triggerPrDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 70,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            const twin = await harness.db.branchSnapshot.create({
                data: { branchId: result.branchId!, source: TriggerSource.WEBHOOK, status: "active" },
            });
            await harness.db.branchSnapshot.update({
                where: { id: result.snapshotId },
                data: { investigationSnapshotId: twin.id },
            });

            // The twin is detached - on the branch, but behind none of its pointers.
            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: result.branchId },
                select: { pendingSnapshotId: true, activeSnapshotId: true, baseSnapshotId: true },
            });
            expect(branch.pendingSnapshotId).toBe(result.snapshotId);
            expect([branch.pendingSnapshotId, branch.activeSnapshotId, branch.baseSnapshotId]).not.toContain(twin.id);

            // The twin stays out of user-facing snapshot history; the PR snapshot does not.
            const history = await harness.services.branches.listSnapshots(result.branchId!, harness.organizationId);
            expect(history.map((s) => s.id)).toContain(result.snapshotId);
            expect(history.map((s) => s.id)).not.toContain(twin.id);

            // The report lives on the twin but resolves from the PR snapshot id via the pairing FK.
            await harness.db.investigationReport.create({
                data: {
                    snapshotId: twin.id,
                    // Only a report carrying the denormalized island header (appSlug) surfaces from
                    // the presence read; a markdown-only row is hidden as unrenderable.
                    appSlug: "test-app",
                    s3Key: "investigation/app/twin.md",
                    testCount: 3,
                    clientBugCount: 1,
                    organizationId: harness.organizationId,
                },
            });
            const report = await harness.services.branches.getInvestigationReport(
                result.snapshotId!,
                harness.organizationId,
            );
            expect(report?.testCount).toBe(3);
            expect(report?.clientBugCount).toBe(1);
        });

        test("throws when PR not found on GitHub", async ({ harness, seedResult: { service } }) => {
            await expect(
                service.triggerPrDiffs({
                    organizationId: harness.organizationId,
                    repoId: 1001,
                    prNumber: 999,
                    url: "https://preview.example.com",
                    webhookUrl: "https://webhook.example.com/hook",
                }),
            ).rejects.toThrow();
        });
    },
});
