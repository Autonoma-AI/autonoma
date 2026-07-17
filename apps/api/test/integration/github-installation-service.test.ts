import { ApplicationArchitecture } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

apiTestSuite({
    name: "GitHubInstallationService",
    seed: async ({ harness }) => {
        const fakeClient = harness.githubApp.defaultClient;

        const app = await harness.services.applications.createApplication({
            name: "Test App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/file.png",
        });

        return { app, fakeClient };
    },
    cases: (test) => {
        test("handleInstallation upserts installation", async ({ harness }) => {
            await harness.services.github.handleInstallation(
                12345,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });

            expect(installation).not.toBeNull();
            expect(installation!.installationId).toBe(12345);
            expect(installation!.accountLogin).toBe("test-org");
            expect(installation!.status).toBe("active");
        });

        test("handleInstallation updates existing installation on re-install", async ({ harness }) => {
            await harness.services.github.handleInstallation(
                12345,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await harness.services.github.handleInstallation(
                12345,
                harness.organizationId,
                "new-org-name",
                999,
                "Organization",
            );

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });

            expect(installation!.accountLogin).toBe("new-org-name");
        });

        test("handleUninstall marks installation as deleted", async ({ harness }) => {
            await harness.services.github.handleInstallation(
                55555,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await harness.services.github.handleUninstall(55555);

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });

            expect(installation!.status).toBe("deleted");
        });

        test("handleSuspend marks installation as suspended", async ({ harness }) => {
            await harness.services.github.handleInstallation(
                66666,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await harness.services.github.handleSuspend(66666);

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });

            expect(installation!.status).toBe("suspended");
        });

        test("listRepositories returns repos from GitHub API with linked app info", async ({
            harness,
            seedResult: { app, fakeClient },
        }) => {
            fakeClient.addRepository({
                id: 2001,
                name: "my-repo",
                fullName: "org/my-repo",
                defaultBranch: "main",
                private: false,
            });
            fakeClient.addRepository({
                id: 2002,
                name: "other-repo",
                fullName: "org/other-repo",
                defaultBranch: "main",
                private: false,
            });

            await harness.services.github.handleInstallation(
                77777,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            // Link app to first repo
            await harness.db.application.update({
                where: { id: app.id },
                data: { githubRepositoryId: 2001 },
            });

            const repos = await harness.services.github.listRepositories(harness.organizationId);
            expect(repos).toHaveLength(2);

            const linkedRepo = repos.find((r) => r.id === 2001);
            expect(linkedRepo?.applicationId).toBe(app.id);

            const unlinkedRepo = repos.find((r) => r.id === 2002);
            expect(unlinkedRepo?.applicationId).toBeUndefined();
        });

        test("listRepositories returns empty array when no installation", async ({ harness }) => {
            const repos = await harness.services.github.listRepositories("nonexistent-org-id");
            expect(repos).toEqual([]);
        });

        test("linkRepository sets githubRepositoryId on application", async ({
            harness,
            seedResult: { app, fakeClient },
        }) => {
            fakeClient.addRepository({
                id: 3001,
                name: "config-repo",
                fullName: "org/config-repo",
                defaultBranch: "main",
                private: false,
            });

            await harness.services.github.handleInstallation(
                88888,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await harness.services.github.linkRepository(harness.organizationId, app.id, 3001);

            const updated = await harness.db.application.findUnique({ where: { id: app.id } });
            expect(updated!.githubRepositoryId).toBe(3001);
        });

        test("linkRepository sets the main-branch deploy ref to the repo's default branch", async ({
            harness,
            seedResult: { app, fakeClient },
        }) => {
            fakeClient.addRepository({
                id: 3009,
                name: "master-repo",
                fullName: "org/master-repo",
                defaultBranch: "master",
                private: false,
            });
            await harness.services.github.handleInstallation(
                88_890,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await harness.services.github.linkRepository(harness.organizationId, app.id, 3009);

            const branch = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranch: { select: { name: true, mainInfo: { select: { githubRef: true } } } } },
            });
            expect(branch.mainBranch?.name).toBe("master");
            expect(branch.mainBranch?.mainInfo?.githubRef).toBe("master");
        });

        test("linkRepository does not overwrite a user-chosen deploy branch on re-link", async ({
            harness,
            seedResult: { app, fakeClient },
        }) => {
            fakeClient.addRepository({
                id: 3011,
                name: "relink-repo",
                fullName: "org/relink-repo",
                defaultBranch: "master",
                private: false,
            });
            await harness.services.github.handleInstallation(
                88_891,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            // First link resolves the deploy ref to the repo default.
            await harness.services.github.linkRepository(harness.organizationId, app.id, 3011);

            // The user then picks a specific branch.
            const appRow = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranchId: true },
            });
            const mainBranchId = appRow.mainBranchId;
            if (mainBranchId == null) throw new Error("seeded app has no main branch");
            await harness.db.branch.update({ where: { id: mainBranchId }, data: { name: "feature-x" } });
            await harness.db.mainBranchInfo.updateMany({
                where: { branchId: mainBranchId },
                data: { githubRef: "feature-x" },
            });

            // Re-linking the same repo must NOT reset that choice back to the default.
            await harness.services.github.linkRepository(harness.organizationId, app.id, 3011);

            const branch = await harness.db.application.findUniqueOrThrow({
                where: { id: app.id },
                select: { mainBranch: { select: { name: true, mainInfo: { select: { githubRef: true } } } } },
            });
            expect(branch.mainBranch?.name).toBe("feature-x");
            expect(branch.mainBranch?.mainInfo?.githubRef).toBe("feature-x");
        });

        test("linkRepository throws NotFoundError for nonexistent app", async ({ harness }) => {
            await harness.services.github.handleInstallation(
                99999,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await expect(
                harness.services.github.linkRepository(harness.organizationId, "nonexistent-app-id", 1234),
            ).rejects.toThrow(NotFoundError);
        });

        test("disconnect removes installation and clears githubRepositoryId", async ({
            harness,
            seedResult: { app },
        }) => {
            await harness.services.github.handleInstallation(
                11111,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await harness.db.application.update({
                where: { id: app.id },
                data: { githubRepositoryId: 5001 },
            });

            await harness.services.github.disconnect(harness.organizationId);

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });
            expect(installation).toBeNull();

            const updatedApp = await harness.db.application.findUnique({ where: { id: app.id } });
            expect(updatedApp!.githubRepositoryId).toBeNull();
        });

        test("disconnect throws NotFoundError when no installation", async ({ harness }) => {
            await expect(harness.services.github.disconnect("nonexistent-org-id")).rejects.toThrow(NotFoundError);
        });
    },
});
