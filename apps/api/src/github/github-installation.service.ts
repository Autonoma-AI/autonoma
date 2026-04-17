import type { PrismaClient, SnapshotStatus, TriggerSource } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import type { GitHubApp, PullRequest, Repository } from "@autonoma/github";
import { Service } from "../routes/service";

export interface DeploymentsDebugResult {
    repository: string | null;
    pullRequests: Array<{
        number: number;
        title: string;
        headRef: string;
        headSha: string;
        url: string;
        createdAt: string;
        updatedAt: string;
    }>;
    branches: Array<{
        id: string;
        name: string;
        githubRef: string | null;
        lastHandledSha: string | null;
        deployment: {
            id: string;
            active: boolean;
            webhookUrl: string | null;
            createdAt: Date;
            webDeployment: { url: string } | null;
            mobileDeployment: { packageName: string } | null;
        } | null;
        snapshots: Array<{
            id: string;
            status: SnapshotStatus;
            source: TriggerSource;
            headSha: string | null;
            baseSha: string | null;
            createdAt: Date;
            _count: { testGenerations: number; testCaseAssignments: number };
        }>;
    }>;
}

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

    async listDeploymentsDebug(organizationId: string, applicationId: string) {
        this.logger.info("Listing deployments debug", { organizationId, applicationId });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { githubRepositoryId: true },
        });

        const repoInfo = await this.resolveRepoInfo(organizationId, app?.githubRepositoryId ?? undefined);

        const [pullRequests, branches] = await Promise.all([
            this.getPullRequests(organizationId, repoInfo),
            this.getBranches(applicationId, organizationId),
        ]);

        this.logger.info("Listed deployments debug", {
            pullRequests: pullRequests.length,
            branches: branches.length,
        });

        return { repository: repoInfo?.fullName ?? null, pullRequests, branches };
    }

    private async resolveRepoInfo(
        organizationId: string,
        githubRepositoryId: number | undefined,
    ): Promise<{ repoId: number; fullName: string } | undefined> {
        if (githubRepositoryId == null) return undefined;

        let client;
        try {
            client = await this.getOrgInstallationClient(organizationId);
        } catch {
            return undefined;
        }

        const repo = await client.getRepository(githubRepositoryId);
        return { repoId: githubRepositoryId, fullName: repo.fullName };
    }

    private getBranches(applicationId: string, organizationId: string) {
        return this.db.branch.findMany({
            where: { applicationId, application: { organizationId } },
            select: {
                id: true,
                name: true,
                githubRef: true,
                lastHandledSha: true,
                deployment: {
                    select: {
                        id: true,
                        active: true,
                        webhookUrl: true,
                        createdAt: true,
                        webDeployment: { select: { url: true } },
                        mobileDeployment: { select: { packageName: true } },
                    },
                },
                snapshots: {
                    select: {
                        id: true,
                        status: true,
                        source: true,
                        headSha: true,
                        baseSha: true,
                        createdAt: true,
                        _count: { select: { testGenerations: true, testCaseAssignments: true } },
                    },
                    orderBy: { createdAt: "desc" },
                    take: 10,
                },
            },
        });
    }

    private async getPullRequests(orgId: string, repoInfo: { repoId: number } | undefined) {
        if (repoInfo == null) return [];

        const client = await this.getOrgInstallationClient(orgId);
        return client.listPullRequests(repoInfo.repoId);
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
