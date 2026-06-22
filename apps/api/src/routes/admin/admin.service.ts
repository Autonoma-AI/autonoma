import type { PrismaClient } from "@autonoma/db";
import type { GitHubApp } from "@autonoma/github";
import type { Auth } from "../../auth";
import { env } from "../../env";
import { Service } from "../service";

type SessionPayload = {
    session: Record<string, unknown>;
    user: Record<string, unknown>;
};

type AdminGitHubRepository = {
    id: number;
    name: string;
    repositoryName: string;
    installationId: number;
    installationAccountLogin: string;
    installationAccountType: string;
};

export class AdminService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly auth: Auth,
        private readonly githubApp: GitHubApp,
    ) {
        super();
    }

    private async updateSessionOrgInRedis(sessionToken: string, orgId: string) {
        const ctx = await this.auth.$context;
        const raw = await ctx.secondaryStorage?.get(sessionToken);
        if (raw == null) return;

        const parsed = JSON.parse(raw as string) as SessionPayload;
        parsed.session.activeOrganizationId = orgId;
        const ttl = Math.floor((new Date(parsed.session.expiresAt as string).getTime() - Date.now()) / 1000);
        await ctx.secondaryStorage?.set(sessionToken, JSON.stringify(parsed), ttl);
    }

    async listOrganizations() {
        this.logger.info("Listing organizations");

        const orgs = await this.db.organization.findMany({
            include: {
                members: { select: { id: true } },
                applications: { select: { id: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        this.logger.info("Organizations listed", { count: orgs.length });

        return orgs.map((org) => ({
            id: org.id,
            name: org.name,
            slug: org.slug,
            createdAt: org.createdAt,
            memberCount: org.members.length,
            applicationCount: org.applications.length,
        }));
    }

    async listPendingOrgs() {
        this.logger.info("Listing pending organizations");

        const orgs = await this.db.organization.findMany({
            where: { status: "pending" },
            include: {
                members: { select: { id: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        this.logger.info("Pending organizations listed", { count: orgs.length });

        return orgs.map((org) => ({
            id: org.id,
            name: org.name,
            slug: org.slug,
            domain: org.domain,
            createdAt: org.createdAt,
            memberCount: org.members.length,
        }));
    }

    async approveOrg(orgId: string) {
        this.logger.info("Approving org", { orgId });

        await this.db.organization.update({
            where: { id: orgId },
            data: { status: "approved" },
        });

        const members = await this.db.member.findMany({
            where: { organizationId: orgId },
            select: { userId: true },
        });

        for (const { userId } of members) {
            const ctx = await this.auth.$context;
            const sessions = await ctx.internalAdapter.listSessions(userId);
            for (const session of sessions) {
                const s = session as typeof session & { activeOrganizationId?: string | null };
                if (s.activeOrganizationId == null) {
                    await this.updateSessionOrgInRedis(session.token, orgId);
                }
            }
        }

        this.logger.info("Org approved and sessions updated", { orgId, memberCount: members.length });
    }

    async rejectOrg(orgId: string) {
        this.logger.info("Rejecting org", { orgId });

        await this.db.organization.update({
            where: { id: orgId },
            data: { status: "rejected" },
        });

        this.logger.info("Org rejected", { orgId });
    }

    async createOrg(name: string, slug: string, domain: string) {
        this.logger.info("Creating organization", { name, slug, domain });

        const org = await this.db.organization.create({
            data: {
                name,
                slug,
                domain,
                status: "approved",
            },
        });

        this.logger.info("Organization created", { orgId: org.id });
        return { id: org.id };
    }

    /**
     * Resolves which organization owns an application slug, searching across ALL
     * organizations (not scoped to the caller's active org). Admin-only because
     * it leaks the existence of other orgs' apps. Used to auto-switch internal
     * users into the right org when they open a cross-org deep link.
     *
     * Application slugs are unique per org, so the same slug can exist in several
     * orgs. The internal org dogfoods customer apps, so it routinely shares slugs
     * with the real customer orgs - an internal user following a shared link
     * always wants the customer's org, never our own copy, so the internal org is
     * excluded whenever a non-internal candidate exists. If that still leaves
     * more than one candidate we cannot disambiguate from the URL alone and
     * return undefined so the caller falls back to the manual org switcher.
     */
    async findOrgByAppSlug(appSlug: string) {
        this.logger.info("Finding organization by app slug", { appSlug });

        const applications = await this.db.application.findMany({
            where: { slug: appSlug, disabled: false },
            select: { organization: { select: { id: true, name: true, slug: true, domain: true } } },
        });

        const external = applications.filter((a) => a.organization.domain !== env.INTERNAL_DOMAIN);
        const candidates = external.length > 0 ? external : applications;

        const [match] = candidates;
        if (match == null) {
            this.logger.info("No application found for slug", { appSlug });
            return undefined;
        }
        if (candidates.length > 1) {
            this.logger.warn("App slug is ambiguous across organizations, skipping auto-resolve", {
                appSlug,
                matchCount: candidates.length,
            });
            return undefined;
        }

        const organization = match.organization;
        this.logger.info("Resolved organization by app slug", { appSlug, orgId: organization.id });
        return { orgId: organization.id, orgName: organization.name, orgSlug: organization.slug };
    }

    async switchToOrg(userId: string, sessionToken: string, orgId: string) {
        this.logger.info("Admin switching to org", { userId, orgId });

        await this.db.member.upsert({
            where: { userId_organizationId: { userId, organizationId: orgId } },
            update: {},
            create: { userId, organizationId: orgId, role: "admin" },
        });

        await this.updateSessionOrgInRedis(sessionToken, orgId);

        this.logger.info("Admin switched to org", { userId, orgId });
    }

    async listGitHubRepositories() {
        this.logger.info("Admin listing all GitHub App repositories");

        const installations = await this.githubApp.listInstallations();
        const repositories: AdminGitHubRepository[] = [];
        let failedInstallationCount = 0;

        for (const installation of installations) {
            try {
                const client = await this.githubApp.getInstallationClient(installation.id);
                const repos = await client.listInstallationRepos();

                for (const repo of repos) {
                    repositories.push({
                        id: repo.id,
                        name: repo.fullName,
                        repositoryName: repo.name,
                        installationId: installation.id,
                        installationAccountLogin: installation.accountLogin,
                        installationAccountType: installation.accountType,
                    });
                }
            } catch (err) {
                // A single broken installation (suspended on GitHub, revoked permissions, etc.)
                // must not bring down the whole admin listing - log it, reconcile its DB status,
                // and keep going with the rest.
                failedInstallationCount++;
                await this.reconcileFailedInstallation(installation.id, installation.accountLogin, err);
            }
        }

        repositories.sort((a, b) => a.name.localeCompare(b.name));

        this.logger.info("Admin listed all GitHub App repositories", {
            installationCount: installations.length,
            failedInstallationCount,
            repositoryCount: repositories.length,
        });

        return repositories;
    }

    /**
     * Marks an installation that failed to list its repos. If GitHub reports the installation as
     * suspended we persist that status so callers (deploys, previewkit) fail fast; any other error
     * is logged and skipped without mutating state, since it may be transient.
     */
    private async reconcileFailedInstallation(installationId: number, accountLogin: string, err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const isSuspended = message.toLowerCase().includes("suspended");

        if (!isSuspended) {
            this.logger.warn("Skipping GitHub installation that failed to list repos", {
                extra: { installationId, accountLogin, error: message },
            });
            return;
        }

        this.logger.warn("Marking GitHub installation as suspended", {
            extra: { installationId, accountLogin, error: message },
        });

        await this.db.gitHubInstallation.updateMany({
            where: { installationId },
            data: { status: "suspended" },
        });
    }

    async getGitHubRepositoryArchiveUrl(input: { installationId: number; repositoryId: number; ref?: string }) {
        this.logger.info("Admin resolving GitHub repository archive URL", {
            installationId: input.installationId,
            repositoryId: input.repositoryId,
            ref: input.ref,
        });

        const client = await this.githubApp.getInstallationClient(input.installationId);
        const repo = await client.getRepository(input.repositoryId);
        const downloadUrl = await client.getRepositoryArchiveUrl(input.repositoryId, input.ref);

        return {
            downloadUrl,
            fileName: `${repo.fullName.replace("/", "-")}.tar.gz`,
        };
    }
}
