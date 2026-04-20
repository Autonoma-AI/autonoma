import { ApplicationArchitecture } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { SnapshotDraft } from "@autonoma/test-updates";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

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
            const result = await service.triggerDiffs({
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

            const branch = await harness.db.branch.findUnique({ where: { id: result.branchId } });
            expect(branch).not.toBeNull();
            expect(branch!.name).toBe("feature/branch-10");
            expect(branch!.githubRef).toBe("feature/branch-10");
            expect(branch!.prNumber).toBe(10);
            expect(branch!.applicationId).toBe(app.id);
            expect(branch!.deploymentId).toBe(result.deploymentId);
            // lastHandledSha is only updated on successful snapshot activation, not at trigger time
            expect(branch!.lastHandledSha).toBeNull();

            const deployment = await harness.db.branchDeployment.findUniqueOrThrow({
                where: { id: result.deploymentId },
                include: { webDeployment: true },
            });
            expect(deployment.webhookUrl).toBe("https://webhook.example.com/hook");
            expect(deployment.webhookHeaders).toEqual({ "X-Auth": "secret" });
            expect(deployment.webDeployment!.url).toBe("https://preview.example.com");

            expect(harness.triggerWorkflow).toHaveBeenCalledWith({ branchId: result.branchId });
        });

        test("triggers diffs for an existing branch", async ({ harness, seedResult: { app, service } }) => {
            const existingBranch = await harness.db.branch.create({
                data: {
                    name: "feature/branch-20",
                    githubRef: "feature/branch-20",
                    prNumber: 20,
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                },
            });

            const result = await service.triggerDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 20,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(result.branchId).toBe(existingBranch.id);

            const branch = await harness.db.branch.findUnique({ where: { id: result.branchId } });
            // lastHandledSha is only updated on successful snapshot activation, not at trigger time
            expect(branch!.lastHandledSha).toBeNull();
        });

        test("uses lastHandledSha as baseSha when available", async ({ harness, seedResult: { app, service } }) => {
            await harness.db.branch.create({
                data: {
                    name: "feature/branch-30",
                    githubRef: "feature/branch-30",
                    prNumber: 30,
                    applicationId: app.id,
                    organizationId: harness.organizationId,
                    lastHandledSha: "previous-sha-999",
                },
            });

            const result = await service.triggerDiffs({
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
            const first = await service.triggerDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 40,
                url: "https://preview.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            const second = await service.triggerDiffs({
                organizationId: harness.organizationId,
                repoId: 1001,
                prNumber: 40,
                url: "https://preview-v2.example.com",
                webhookUrl: "https://webhook.example.com/hook",
            });

            expect(second.branchId).toBe(first.branchId);
            expect(second.snapshotId).not.toBe(first.snapshotId);

            // discard() deletes the old snapshot record
            const oldSnapshot = await harness.db.branchSnapshot.findUnique({ where: { id: first.snapshotId } });
            expect(oldSnapshot).toBeNull();

            // The new snapshot should be processing
            const newSnapshot = await harness.db.branchSnapshot.findUnique({ where: { id: second.snapshotId } });
            expect(newSnapshot).not.toBeNull();
            expect(newSnapshot!.status).toBe("processing");
        });

        test("throws NotFoundError when no application linked to repo", async ({
            harness,
            seedResult: { service },
        }) => {
            await expect(
                service.triggerDiffs({
                    organizationId: harness.organizationId,
                    repoId: 9999,
                    prNumber: 50,
                    url: "https://preview.example.com",
                    webhookUrl: "https://webhook.example.com/hook",
                }),
            ).rejects.toThrow(NotFoundError);
        });

        test("inherits test case and skill assignments from main branch on a new PR branch", async ({
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

            const mainDraft = await SnapshotDraft.start({ db: harness.db, branchId: mainBranch.id });
            const { testCaseId: inheritedTestCaseId } = await mainDraft.addTestCase({
                folderId: folder.id,
                name: "Diffs inherited test",
                description: "Inherited by PR branches",
                plan: "Open homepage",
            });
            const { skillId: inheritedSkillId } = await mainDraft.addSkill({
                name: "Diffs inherited skill",
                description: "Inherited by PR branches",
                plan: "Log in",
            });
            await mainDraft.activate();

            const result = await service.triggerDiffs({
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

            const skillAssignments = await harness.db.skillAssignment.findMany({
                where: { snapshotId: result.snapshotId },
                select: { skillId: true },
            });
            expect(skillAssignments).toHaveLength(1);
            expect(skillAssignments[0]!.skillId).toBe(inheritedSkillId);
        });

        test("throws NotFoundError when no GitHub installation", async ({ harness, seedResult: { service } }) => {
            await harness.db.gitHubInstallation.deleteMany({
                where: { organizationId: harness.organizationId },
            });

            await expect(
                service.triggerDiffs({
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
                service.triggerDiffs({
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
