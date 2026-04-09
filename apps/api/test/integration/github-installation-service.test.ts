import { ApplicationArchitecture } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { expect, vi } from "vitest";
import { apiTestSuite } from "../api-test";

vi.mock("@autonoma/workflow", () => ({
    triggerTestCaseGenerationJob: vi.fn().mockResolvedValue(undefined),
}));

const mockInstallationClient = {
    listInstallationRepos: vi.fn(),
    compareCommits: vi.fn(),
};

apiTestSuite({
    name: "GitHubInstallationService",
    seed: async ({ harness }) => {
        // Mock the githubApp on the service to return our mock client
        const service = harness.services.github;
        const githubApp = (service as unknown as { githubApp: { getInstallationClient: ReturnType<typeof vi.fn>; deleteInstallation: ReturnType<typeof vi.fn>; slug: string } }).githubApp;
        githubApp.getInstallationClient = vi.fn().mockResolvedValue(mockInstallationClient);
        githubApp.deleteInstallation = vi.fn().mockResolvedValue(undefined);
        githubApp.slug = "test-app";

        const app = await harness.services.applications.createApplication({
            name: "Test App",
            organizationId: harness.organizationId,
            architecture: ApplicationArchitecture.WEB,
            url: "https://example.com",
            file: "s3://bucket/file.png",
        });

        return { app };
    },
    cases: (test) => {
        test("handleInstallation upserts installation and repos", async ({ harness }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([
                { id: 1001, name: "repo-a", fullName: "org/repo-a", defaultBranch: "main", private: false },
                { id: 1002, name: "repo-b", fullName: "org/repo-b", defaultBranch: "develop", private: true },
            ]);

            await harness.services.github.handleInstallation(
                12345,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
                include: { repositories: true },
            });

            expect(installation).not.toBeNull();
            expect(installation!.installationId).toBe(12345);
            expect(installation!.accountLogin).toBe("test-org");
            expect(installation!.status).toBe("active");
            expect(installation!.repositories).toHaveLength(2);

            const repoNames = installation!.repositories.map((r) => r.name);
            expect(repoNames).toContain("repo-a");
            expect(repoNames).toContain("repo-b");
        });

        test("handleInstallation updates existing installation on re-install", async ({ harness }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([
                { id: 1001, name: "repo-a", fullName: "org/repo-a", defaultBranch: "main", private: false },
            ]);

            await harness.services.github.handleInstallation(
                12345,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            // Re-install with updated account login and different repos
            mockInstallationClient.listInstallationRepos.mockResolvedValue([
                { id: 1001, name: "repo-a-renamed", fullName: "org/repo-a-renamed", defaultBranch: "main", private: false },
                { id: 1003, name: "repo-c", fullName: "org/repo-c", defaultBranch: "main", private: false },
            ]);

            await harness.services.github.handleInstallation(
                12345,
                harness.organizationId,
                "new-org-name",
                999,
                "Organization",
            );

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
                include: { repositories: true },
            });

            expect(installation!.accountLogin).toBe("new-org-name");
            expect(installation!.repositories).toHaveLength(3);
        });

        test("handleUninstall marks installation as deleted", async ({ harness }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([]);

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
            mockInstallationClient.listInstallationRepos.mockResolvedValue([]);

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

        test("listRepositories returns repos for the org", async ({ harness }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([
                { id: 2001, name: "my-repo", fullName: "org/my-repo", defaultBranch: "main", private: false },
            ]);

            await harness.services.github.handleInstallation(
                77777,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            const repos = await harness.services.github.listRepositories(harness.organizationId);
            const myRepo = repos.find((r) => r.name === "my-repo");
            expect(myRepo).toBeDefined();
        });

        test("listRepositories throws NotFoundError when no installation", async ({ harness }) => {
            // Use a random org ID that has no installation
            await expect(harness.services.github.listRepositories("nonexistent-org-id")).rejects.toThrow(NotFoundError);
        });

        test("updateRepoConfig updates watch branch and deployment trigger", async ({ harness, seedResult: { app } }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([
                { id: 3001, name: "config-repo", fullName: "org/config-repo", defaultBranch: "main", private: false },
            ]);

            await harness.services.github.handleInstallation(
                88888,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
                include: { repositories: true },
            });

            const repo = installation!.repositories[0]!;

            await harness.services.github.updateRepoConfig(
                harness.organizationId,
                repo.id,
                "main",
                "push",
                app.id,
            );

            const updated = await harness.db.gitHubRepository.findUnique({ where: { id: repo.id } });
            expect(updated!.watchBranch).toBe("main");
            expect(updated!.deploymentTrigger).toBe("push");
            expect(updated!.applicationId).toBe(app.id);
        });

        test("updateRepoConfig throws NotFoundError for nonexistent repo", async ({ harness }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([]);

            await harness.services.github.handleInstallation(
                99999,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await expect(
                harness.services.github.updateRepoConfig(
                    harness.organizationId,
                    "nonexistent-repo-id",
                    "main",
                    "push",
                    undefined,
                ),
            ).rejects.toThrow(NotFoundError);
        });

        test("disconnect removes installation from database", async ({ harness }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([]);

            await harness.services.github.handleInstallation(
                11111,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await harness.services.github.disconnect(harness.organizationId);

            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
            });

            expect(installation).toBeNull();
        });

        test("disconnect throws NotFoundError when no installation", async ({ harness }) => {
            await expect(harness.services.github.disconnect("nonexistent-org-id")).rejects.toThrow(NotFoundError);
        });

        test("handleDeploymentNotification creates deployment and fetches diff", async ({ harness }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([
                { id: 4001, name: "deploy-repo", fullName: "org/deploy-repo", defaultBranch: "main", private: false },
            ]);

            await harness.services.github.handleInstallation(
                22222,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            mockInstallationClient.compareCommits.mockResolvedValue({
                aheadBy: 1,
                behindBy: 0,
                status: "ahead",
                files: [{ filename: "src/index.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
            });

            await harness.services.github.handleDeploymentNotification(
                harness.organizationId,
                "org/deploy-repo",
                "abc123",
                "def456",
                "production",
                "https://example.com",
            );

            // The deployment is created synchronously, diff is fetched async
            const installation = await harness.db.gitHubInstallation.findUnique({
                where: { organizationId: harness.organizationId },
                include: { repositories: true },
            });
            const repo = installation!.repositories[0]!;

            const deployment = await harness.db.gitHubDeployment.findFirst({
                where: { repositoryId: repo.id },
            });

            expect(deployment).not.toBeNull();
            expect(deployment!.sha).toBe("abc123");
            expect(deployment!.baseSha).toBe("def456");
            expect(deployment!.environment).toBe("production");
        });

        test("handleDeploymentNotification throws for unknown repo", async ({ harness }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([]);

            await harness.services.github.handleInstallation(
                33333,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await expect(
                harness.services.github.handleDeploymentNotification(
                    harness.organizationId,
                    "org/unknown-repo",
                    "abc",
                    undefined,
                    "staging",
                    undefined,
                ),
            ).rejects.toThrow(NotFoundError);
        });

        test("handleBranchDeployment creates branch and deployment", async ({ harness, seedResult: { app } }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([
                { id: 5001, name: "branch-repo", fullName: "org/branch-repo", defaultBranch: "main", private: false },
            ]);

            await harness.services.github.handleInstallation(
                44444,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            // Link the repo to the app
            const repo = await harness.db.gitHubRepository.findFirst({
                where: { fullName: "org/branch-repo" },
            });
            await harness.db.gitHubRepository.update({
                where: { id: repo!.id },
                data: { applicationId: app.id },
            });

            const result = await harness.services.github.handleBranchDeployment(
                harness.organizationId,
                "org/branch-repo",
                "refs/heads/feature/my-branch",
                "sha123",
                "https://preview.example.com",
                "preview",
            );

            expect(result.branchId).toBeDefined();
            expect(result.deploymentId).toBeDefined();

            const branch = await harness.db.branch.findUnique({ where: { id: result.branchId } });
            expect(branch).not.toBeNull();
            expect(branch!.githubRef).toBe("feature/my-branch");
            expect(branch!.applicationId).toBe(app.id);
        });

        test("handleBranchDeployment reuses existing branch", async ({ harness, seedResult: { app } }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([
                { id: 6001, name: "reuse-repo", fullName: "org/reuse-repo", defaultBranch: "main", private: false },
            ]);

            await harness.services.github.handleInstallation(
                55556,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            const repo = await harness.db.gitHubRepository.findFirst({
                where: { fullName: "org/reuse-repo" },
            });
            await harness.db.gitHubRepository.update({
                where: { id: repo!.id },
                data: { applicationId: app.id },
            });

            // Create first deployment
            const first = await harness.services.github.handleBranchDeployment(
                harness.organizationId,
                "org/reuse-repo",
                "my-branch",
                "sha1",
                "https://v1.example.com",
                undefined,
            );

            // Create second deployment on same branch
            const second = await harness.services.github.handleBranchDeployment(
                harness.organizationId,
                "org/reuse-repo",
                "my-branch",
                "sha2",
                "https://v2.example.com",
                undefined,
            );

            expect(first.branchId).toBe(second.branchId);
            expect(first.deploymentId).not.toBe(second.deploymentId);
        });

        test("handleBranchDeployment throws when repo not linked to app", async ({ harness }) => {
            mockInstallationClient.listInstallationRepos.mockResolvedValue([
                { id: 7001, name: "unlinked-repo", fullName: "org/unlinked-repo", defaultBranch: "main", private: false },
            ]);

            await harness.services.github.handleInstallation(
                66667,
                harness.organizationId,
                "test-org",
                999,
                "Organization",
            );

            await expect(
                harness.services.github.handleBranchDeployment(
                    harness.organizationId,
                    "org/unlinked-repo",
                    "main",
                    "sha123",
                    "https://example.com",
                    undefined,
                ),
            ).rejects.toThrow("not linked to an application");
        });
    },
});
