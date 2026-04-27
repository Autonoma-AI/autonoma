import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { Commit, GitHubApp, PullRequest, Repository } from "@autonoma/github";
import { Service } from "../routes/service";

export interface ListedRepository extends Repository {
    applicationId: string | undefined;
    applicationName: string | undefined;
}

export class GitHubInstallationService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly githubApp: GitHubApp,
    ) {
        super();
    }

    getSlug(): string {
        return this.githubApp.slug;
    }

    async handleInstallation(
        installationId: number,
        orgId: string,
        accountLogin: string,
        accountId: number,
        accountType: string,
    ): Promise<void> {
        this.logger.info("Handling GitHub installation", { installationId, orgId, accountLogin });

        await this.db.gitHubInstallation.upsert({
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

        this.logger.info("Installation upserted", { installationId, orgId });
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
        });
    }

    async getRepository(orgId: string, repoId: number): Promise<Repository> {
        this.logger.info("Fetching repository", { orgId, repoId });

        const client = await this.getOrgInstallationClient(orgId);
        return client.getRepository(repoId);
    }

    async getPullRequest(orgId: string, repoId: number, prNumber: number): Promise<PullRequest> {
        this.logger.info("Fetching pull request", { orgId, repoId, prNumber });

        const client = await this.getOrgInstallationClient(orgId);
        return client.getPullRequest(repoId, prNumber);
    }

    async getBranchHead(orgId: string, repoId: number, branchName: string): Promise<string> {
        this.logger.info("Fetching branch head", { orgId, repoId, branchName });

        const client = await this.getOrgInstallationClient(orgId);
        return client.getBranchHead(repoId, branchName);
    }

    async getApplicationPullRequest(
        organizationId: string,
        applicationId: string,
        prNumber: number,
    ): Promise<PullRequest> {
        this.logger.info("Fetching application pull request", { organizationId, applicationId, prNumber });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });

        if (app == null) throw new NotFoundError("Application not found");
        if (app.githubRepositoryId == null) {
            throw new NotFoundError("Application is not linked to a GitHub repository");
        }

        const client = await this.getOrgInstallationClient(organizationId);
        const pullRequest = await client.getPullRequest(app.githubRepositoryId, prNumber);

        this.logger.info("Fetched application pull request", { applicationId, prNumber });

        return pullRequest;
    }

    async getApplicationCommit(organizationId: string, applicationId: string, sha: string): Promise<Commit> {
        this.logger.info("Fetching application commit", { organizationId, applicationId, sha });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });

        if (app == null) throw new NotFoundError("Application not found");
        if (app.githubRepositoryId == null) {
            throw new NotFoundError("Application is not linked to a GitHub repository");
        }

        const client = await this.getOrgInstallationClient(organizationId);
        const commit = await client.getCommit(app.githubRepositoryId, sha);

        this.logger.info("Fetched application commit", { applicationId, sha: commit.sha });

        return commit;
    }

    async listRepositories(orgId: string): Promise<ListedRepository[]> {
        this.logger.info("Listing repositories", { orgId });

        const client = await this.getOrgInstallationClient(orgId);
        const repos = await client.listInstallationRepos();

        const linkedApps = await this.db.application.findMany({
            where: {
                organizationId: orgId,
                githubRepositoryId: { not: null },
            },
            select: { id: true, name: true, githubRepositoryId: true },
        });

        const appByRepoId = new Map(linkedApps.map((app) => [app.githubRepositoryId!, { id: app.id, name: app.name }]));

        return repos.map((repo) => {
            const linkedApp = appByRepoId.get(repo.id);
            return {
                ...repo,
                applicationId: linkedApp?.id,
                applicationName: linkedApp?.name,
            };
        });
    }

    async linkRepository(orgId: string, applicationId: string, githubRepoId: number): Promise<void> {
        this.logger.info("Linking repository to application", { orgId, applicationId, githubRepoId });

        const client = await this.getOrgInstallationClient(orgId);

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId: orgId },
        });

        if (app == null) throw new NotFoundError();

        await client.getRepository(githubRepoId);

        await this.db.application.update({
            where: { id: applicationId },
            data: { githubRepositoryId: githubRepoId },
        });

        this.logger.info("Repository linked to application", { applicationId, githubRepoId });
    }

    async disconnect(orgId: string): Promise<void> {
        this.logger.info("Disconnecting GitHub installation", { orgId });

        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
        });

        if (installation == null) throw new NotFoundError();

        try {
            await this.githubApp.deleteInstallation(installation.installationId);
            this.logger.info("GitHub installation deleted from GitHub", {
                installationId: installation.installationId,
            });
        } catch (err) {
            this.logger.warn("Failed to delete installation from GitHub - removing locally anyway", {
                installationId: installation.installationId,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        await this.db.$transaction(async (tx) => {
            await tx.application.updateMany({
                where: { organizationId: orgId },
                data: { githubRepositoryId: null },
            });

            await tx.gitHubInstallation.delete({
                where: { organizationId: orgId },
            });
        });
    }

    private async getOrgInstallationClient(orgId: string) {
        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
        });

        if (installation == null) throw new NotFoundError("No GitHub installation found");

        return this.githubApp.getInstallationClient(installation.installationId);
    }
}
