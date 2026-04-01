import type { GitHubDeploymentTrigger, GitHubRepository, PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { triggerTestCaseGenerationJob } from "@autonoma/workflow";
import { Service } from "../routes/service";
import { getGithubApp } from "./github-app";

export class GitHubInstallationService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async handleInstallation(
        installationId: number,
        orgId: string,
        accountLogin: string,
        accountId: number,
        accountType: string,
    ): Promise<void> {
        this.logger.info("Handling GitHub installation", { installationId, orgId, accountLogin });

        const app = getGithubApp();
        const octokit = await app.getInstallationOctokit(installationId);

        const reposResponse = await octokit.request("GET /installation/repositories", { per_page: 100 });
        const repos = reposResponse.data.repositories;

        this.logger.info("Upserting installation and repositories", { count: repos.length, installationId });

        await this.db.$transaction(async (tx) => {
            const installation = await tx.gitHubInstallation.upsert({
                where: { organizationId: orgId },
                create: {
                    installationId,
                    organizationId: orgId,
                    accountLogin,
                    accountId,
                    accountType,
                    status: "active",
                },
                update: {
                    installationId,
                    accountLogin,
                    accountId,
                    accountType,
                    status: "active",
                },
            });

            for (const repo of repos) {
                await tx.gitHubRepository.upsert({
                    where: {
                        installationId_githubRepoId: {
                            installationId: installation.id,
                            githubRepoId: repo.id,
                        },
                    },
                    create: {
                        installationId: installation.id,
                        githubRepoId: repo.id,
                        name: repo.name,
                        fullName: repo.full_name,
                        defaultBranch: repo.default_branch,
                        private: repo.private,
                        indexingStatus: "pending",
                    },
                    update: {
                        name: repo.name,
                        fullName: repo.full_name,
                        defaultBranch: repo.default_branch,
                        private: repo.private,
                        indexingStatus: "pending",
                    },
                });
            }
        });
    }

    async handleUninstall(installationId: number): Promise<void> {
        this.logger.info("Handling GitHub uninstall", { installationId });

        await this.db.gitHubInstallation.updateMany({
            where: { installationId },
            data: { status: "deleted" },
        });
    }

    async handleSuspend(installationId: number): Promise<void> {
        this.logger.info("Handling GitHub suspension", { installationId });

        await this.db.gitHubInstallation.updateMany({
            where: { installationId },
            data: { status: "suspended" },
        });
    }

    async getInstallation(orgId: string) {
        return this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
            include: { repositories: true },
        });
    }

    async getTestCases(orgId: string, applicationId: string) {
        this.logger.info("Fetching test cases", { orgId, applicationId });

        return this.db.testCase.findMany({
            where: { applicationId, organizationId: orgId },
            include: { plans: { orderBy: { createdAt: "desc" }, take: 1 } },
            orderBy: { name: "asc" },
        });
    }

    async listRepositories(orgId: string) {
        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
            include: { repositories: true },
        });

        if (installation == null) throw new NotFoundError();

        return installation.repositories;
    }

    async updateRepoConfig(
        orgId: string,
        repoId: string,
        watchBranch: string,
        deploymentTrigger: GitHubDeploymentTrigger,
        applicationId: string | undefined,
    ): Promise<void> {
        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
        });

        if (installation == null) throw new NotFoundError();

        const existingRepo = await this.db.gitHubRepository.findFirst({
            where: { id: repoId, installationId: installation.id },
        });

        if (existingRepo == null) throw new NotFoundError();

        await this.db.gitHubRepository.update({
            where: { id: repoId },
            data: { watchBranch, deploymentTrigger, applicationId },
        });

        this.logger.info("Updated repo config", { repoId, watchBranch, deploymentTrigger, applicationId });

        const isNewAppLink = applicationId != null && existingRepo.applicationId !== applicationId;
        if (isNewAppLink) {
            this.logger.info("Application newly linked, triggering indexing", { repoId, applicationId });
            void this.indexRepository({
                ...existingRepo,
                applicationId,
                installation: { organizationId: orgId },
            }).catch((error: unknown) => {
                this.logger.fatal("Repository indexing failed", error, { repoId, applicationId });
            });
        }
    }

    async handleDeploymentNotification(
        orgId: string,
        repoFullName: string,
        sha: string,
        baseSha: string | undefined,
        environment: string,
        url: string | undefined,
    ): Promise<void> {
        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
            include: { repositories: { where: { fullName: repoFullName } } },
        });

        if (installation == null) throw new NotFoundError();

        const repo = installation.repositories[0];
        if (repo == null) throw new NotFoundError();

        const deployment = await this.db.gitHubDeployment.create({
            data: {
                repositoryId: repo.id,
                sha,
                baseSha,
                environment,
                url,
                status: "fetching_diff",
            },
        });

        this.logger.info("Deployment notification received, fetching diff", {
            repoFullName,
            sha,
            baseSha,
            environment,
        });

        void this.fetchAndStoreDiff(deployment.id, repo, installation.installationId, sha, baseSha).catch((error) => {
            this.logger.fatal("Failed to fetch and store deployment diff", error, { deploymentId: deployment.id });
        });
    }

    private async fetchAndStoreDiff(
        deploymentId: string,
        repo: GitHubRepository,
        installationId: number,
        sha: string,
        baseSha: string | undefined,
    ): Promise<void> {
        const [owner, repoName] = repo.fullName.split("/");
        if (owner == null || repoName == null) throw new Error(`Invalid repo fullName: ${repo.fullName}`);

        const resolvedBase = baseSha ?? `${sha}^`;

        try {
            const app = getGithubApp();
            const octokit = await app.getInstallationOctokit(installationId);

            const response = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
                owner,
                repo: repoName,
                basehead: `${resolvedBase}...${sha}`,
            });

            const files = response.data.files ?? [];
            const diff = files.map((f) => `--- ${f.filename}\n+++ ${f.filename}\n${f.patch ?? ""}`).join("\n\n");

            await this.db.gitHubDeployment.update({
                where: { id: deploymentId },
                data: { diff, status: "ready" },
            });

            this.logger.info("Diff stored for deployment", {
                deploymentId,
                filesChanged: files.length,
            });
        } catch (err) {
            await this.db.gitHubDeployment.update({
                where: { id: deploymentId },
                data: { status: "failed" },
            });
            throw err;
        }
    }

    async disconnect(orgId: string): Promise<void> {
        this.logger.info("Disconnecting GitHub installation", { orgId });

        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
        });

        if (installation == null) throw new NotFoundError();

        await this.db.gitHubInstallation.delete({
            where: { organizationId: orgId },
        });
    }

    async indexAllRepositories(installationId: string): Promise<void> {
        const installation = await this.db.gitHubInstallation.findUnique({
            where: { id: installationId },
            include: { repositories: true },
        });

        if (installation == null) return;

        this.logger.info("Starting repository indexing", {
            installationId,
            repoCount: installation.repositories.length,
        });

        for (const repo of installation.repositories) {
            try {
                await this.indexRepository({ ...repo, installation });
            } catch (error) {
                this.logger.fatal("Failed to index repository", error, { repoId: repo.id, fullName: repo.fullName });
            }
        }

        this.logger.info("Repository indexing complete", { installationId });
    }

    async indexRepository(repo: GitHubRepository & { installation: { organizationId: string } }): Promise<void> {
        this.logger.info("Triggering test case generation job", { repoId: repo.id, fullName: repo.fullName });

        if (repo.applicationId == null) {
            this.logger.warn("Skipping indexing - no application linked to repo", { repoId: repo.id });
            return;
        }

        await this.db.gitHubRepository.update({
            where: { id: repo.id },
            data: { indexingStatus: "running" },
        });

        try {
            await triggerTestCaseGenerationJob(repo.id);

            await this.db.gitHubRepository.update({
                where: { id: repo.id },
                data: { indexingStatus: "completed", indexedAt: new Date() },
            });

            this.logger.info("Test case generation job triggered", { repoId: repo.id, fullName: repo.fullName });
        } catch (err) {
            await this.db.gitHubRepository.update({
                where: { id: repo.id },
                data: { indexingStatus: "failed" },
            });
            throw err;
        }
    }
}
