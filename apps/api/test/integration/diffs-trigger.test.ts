import type { PrismaClient } from "@autonoma/db";
import { ApplicationArchitecture, TriggerSource } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { AddTest, TestSuiteUpdater } from "@autonoma/test-updates";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

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

        await harness.services.github.handleInstallation(
            12345,
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

            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                branchId: result.branchId,
                snapshotId: result.snapshotId,
            });
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

            // Its DiffsJob is marked failed with a superseded reason
            const oldDiffsJob = await harness.db.diffsJob.findUnique({ where: { snapshotId: first.snapshotId } });
            expect(oldDiffsJob!.status).toBe("failed");
            expect(oldDiffsJob!.failureReason).toBe("Superseded by a newer diffs request");

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

            // cancelDiffsJob was called with the stale snapshot's id, and the second
            // triggerDiffsJob call carries the new snapshot id.
            expect(harness.triggerWorkflow).toHaveBeenCalledWith(first.snapshotId);
            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                branchId: second.branchId,
                snapshotId: second.snapshotId,
            });
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

            expect(harness.triggerWorkflow).toHaveBeenCalledWith({
                branchId: result.branchId,
                snapshotId: result.snapshotId,
            });
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
