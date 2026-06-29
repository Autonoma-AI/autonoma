import type { PrismaClient } from "@autonoma/db";
import { Prisma } from "@autonoma/db";
import { ConflictError, NotFoundError } from "@autonoma/errors";
import type {
    Commit,
    GitHubApp,
    ListPullRequestsResult,
    PullRequest,
    PullRequestCommit,
    Repository,
} from "@autonoma/github";
import { Service } from "../routes/service";

export interface ListedRepository extends Repository {
    applicationId: string | undefined;
    applicationName: string | undefined;
}

/** Bound for the GitHub repo listing - a stale/uninstalled app can hang the token mint. */
const LIST_REPOSITORIES_TIMEOUT_MS = 8_000;

/** Reject `promise` if it doesn't settle within `ms`, clearing the timer either way. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer != null) clearTimeout(timer);
    }
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

    async findOrganizationIdByInstallationId(installationId: number): Promise<string | undefined> {
        const installation = await this.db.gitHubInstallation.findFirst({
            where: { installationId },
            select: { organizationId: true },
        });
        return installation?.organizationId;
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

    async getApplicationRepository(organizationId: string, applicationId: string): Promise<Repository | null> {
        this.logger.info("Fetching application repository", { organizationId, applicationId });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });

        if (app == null) throw new NotFoundError("Application not found");
        if (app.githubRepositoryId == null) return null;

        const client = await this.getOrgInstallationClient(organizationId);
        const repository = await client.getRepository(app.githubRepositoryId);

        this.logger.info("Fetched application repository", {
            applicationId,
            githubRepositoryId: app.githubRepositoryId,
            fullName: repository.fullName,
        });

        return repository;
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

    async listApplicationPullRequests(organizationId: string, applicationId: string): Promise<ListPullRequestsResult> {
        this.logger.info("Listing application open pull requests", { organizationId, applicationId });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });

        if (app == null) throw new NotFoundError("Application not found");
        if (app.githubRepositoryId == null) {
            throw new NotFoundError("Application is not linked to a GitHub repository");
        }

        const client = await this.getOrgInstallationClient(organizationId);
        const result = await client.listOpenPullRequests(app.githubRepositoryId);

        this.logger.info("Listed application open pull requests", {
            organizationId,
            applicationId,
            unchanged: result.unchanged,
        });

        return result;
    }

    /**
     * Lists one bounded page of the most-recently-updated closed PRs (merged PRs included,
     * split out by `merged_at`). One ETag-conditional request - the same cost class as
     * {@link listApplicationPullRequests} - used by the cache to classify merged vs closed
     * for PRs that just left the open list. We never paginate the full closed history.
     */
    async listApplicationClosedPullRequests(
        organizationId: string,
        applicationId: string,
    ): Promise<ListPullRequestsResult> {
        this.logger.info("Listing application closed pull requests", { organizationId, applicationId });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });

        if (app == null) throw new NotFoundError("Application not found");
        if (app.githubRepositoryId == null) {
            throw new NotFoundError("Application is not linked to a GitHub repository");
        }

        const client = await this.getOrgInstallationClient(organizationId);
        const result = await client.listClosedPullRequests(app.githubRepositoryId);

        this.logger.info("Listed application closed pull requests", {
            organizationId,
            applicationId,
            unchanged: result.unchanged,
        });

        return result;
    }

    async listApplicationPullRequestCommits(
        organizationId: string,
        applicationId: string,
        prNumber: number,
    ): Promise<PullRequestCommit[]> {
        this.logger.info("Listing application pull request commits", { organizationId, applicationId, prNumber });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });

        if (app == null) throw new NotFoundError("Application not found");
        if (app.githubRepositoryId == null) {
            throw new NotFoundError("Application is not linked to a GitHub repository");
        }

        const client = await this.getOrgInstallationClient(organizationId);
        const commits = await client.listPullRequestCommits(app.githubRepositoryId, prNumber);

        this.logger.info("Listed application pull request commits", { applicationId, prNumber, count: commits.length });

        return commits;
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

        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
        });
        if (installation == null) return [];

        try {
            const repos = await withTimeout(
                (async () => {
                    const client = await this.githubApp.getInstallationClient(installation.installationId);
                    return client.listInstallationRepos();
                })(),
                LIST_REPOSITORIES_TIMEOUT_MS,
                "listInstallationRepos",
            );

            const linkedApps = await this.db.application.findMany({
                where: {
                    organizationId: orgId,
                    githubRepositoryId: { not: null },
                },
                select: { id: true, name: true, githubRepositoryId: true },
            });

            const appByRepoId = new Map(
                linkedApps.map((app) => [app.githubRepositoryId!, { id: app.id, name: app.name }]),
            );

            return repos.map((repo) => {
                const linkedApp = appByRepoId.get(repo.id);
                return {
                    ...repo,
                    applicationId: linkedApp?.id,
                    applicationName: linkedApp?.name,
                };
            });
        } catch (err) {
            this.logger.warn("Failed to list installation repositories - installation may be stale or uninstalled", {
                installationId: installation.installationId,
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    }

    async linkRepository(orgId: string, applicationId: string, githubRepoId: number): Promise<void> {
        this.logger.info("Linking repository to application", { orgId, applicationId, githubRepoId });

        const client = await this.getOrgInstallationClient(orgId);

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId: orgId },
        });

        if (app == null) throw new NotFoundError();

        await client.getRepository(githubRepoId);

        try {
            await this.db.application.update({
                where: { id: applicationId },
                data: { githubRepositoryId: githubRepoId },
            });
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                throw new ConflictError("This repository is already linked to another application");
            }
            throw error;
        }

        this.logger.info("Repository linked to application", { applicationId, githubRepoId });
    }

    /**
     * Unlinks the repository from a single application, leaving the org-wide GitHub
     * installation (and every other application's link) untouched. This is the
     * scoped counterpart to `disconnect`, which tears down the whole installation.
     */
    async unlinkRepository(orgId: string, applicationId: string): Promise<void> {
        this.logger.info("Unlinking repository from application", { orgId, applicationId });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId: orgId },
            select: { id: true, githubRepositoryId: true },
        });

        if (app == null) throw new NotFoundError("Application not found");

        if (app.githubRepositoryId == null) {
            this.logger.info("Application has no linked repository, nothing to unlink", { applicationId });
            return;
        }

        await this.db.application.update({
            where: { id: applicationId },
            data: { githubRepositoryId: null },
        });

        this.logger.info("Repository unlinked from application", { applicationId });
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
