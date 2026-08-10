import type { PrismaClient } from "@autonoma/db";
import { Prisma } from "@autonoma/db";
import { ConflictError, NotFoundError } from "@autonoma/errors";
import {
    type Commit,
    type GitHubApp,
    GitHubInstallationUnavailableError,
    type ListPullRequestsResult,
    type PullRequest,
    type PullRequestCommit,
    type Repository,
} from "@autonoma/github";
import { z } from "zod";
import { env } from "../env";
import { Service } from "../routes/service";
import { applicationBranchRefs } from "./application-branch-refs";
import { githubErrorStatus } from "./git-ref";

/**
 * The GitHub account an installation sits on. Octokit types `account` as `unknown` (it is one
 * of several union members depending on the account kind), so it is validated here rather than
 * asserted at each call site.
 */
const InstallationAccountSchema = z.object({
    login: z.string().min(1),
    id: z.number(),
    type: z.string().min(1),
});

export type InstallationAccount = z.infer<typeof InstallationAccountSchema>;

/** The GitHub account an installation sits on, plus when GitHub created the installation. */
export interface InstallationDetails extends InstallationAccount {
    createdAt: Date;
}

/**
 * How recently GitHub must have created an installation for a callback to be allowed to bind it to
 * an organization for the FIRST time. Configurable (`GITHUB_INSTALL_FRESHNESS_MINUTES`) only so a
 * test environment can shrink it - the default is the value production runs.
 *
 * The install callback is unauthenticated and its signed state proves only which organization
 * asked to install - never which installation, because state is minted before the installation
 * exists. That leaves replay: mint a link for your own workspace, then present it with someone
 * else's `installation_id`. Requiring the installation to be seconds old is what makes that
 * impractical: a real callback always arrives moments after GitHub creates the installation,
 * whereas an enumerated id is almost always old. It narrows the attack to racing an install that
 * is happening right now, on an id you would already have to know.
 *
 * Generous on purpose - a slow approval screen must not break a legitimate install.
 */
const FRESH_INSTALL_WINDOW_MS = env.GITHUB_INSTALL_FRESHNESS_MINUTES * 60 * 1000;

export interface ListedRepository extends Repository {
    applicationId: string | undefined;
    applicationName: string | undefined;
}

/**
 * One organization's installation repositories, or why they could not be read.
 *
 * The listing used to degrade to a bare `[]` on any GitHub failure, which every
 * caller then rendered as "this org has no repositories" - a short list that
 * looks complete. `unavailable` makes the difference representable, so a caller
 * can say the list is incomplete instead of quietly dropping repos the user owns.
 */
export interface RepositoryListing {
    repos: ListedRepository[];
    /** Set when the installation could not be read: `repos` is empty and is NOT the org's real repository set. */
    unavailable?: string;
}

/** Bound for the GitHub repo listing - a stale/uninstalled app can hang the token mint. */
const LIST_REPOSITORIES_TIMEOUT_MS = 8_000;

/** The `push` payload fields the trunk reconciliation reads; the rest belong to other handlers. */
const pushRepositorySchema = z.object({
    repository: z.object({
        id: z.number().int().positive(),
        default_branch: z.string().optional(),
    }),
});

/** Apps whose default branch is resolved together during a trunk-pin audit. */
const TRUNK_AUDIT_BATCH_SIZE = 10;

/**
 * One application whose trunk record disagrees with its repository's real default
 * branch - the residue of the era when choosing a deploy branch overwrote the
 * trunk. `unreadable` means GitHub would not say what the default branch is, so
 * the app is neither confirmed healthy nor confirmed mispinned.
 */
export interface TrunkPinAudit {
    applicationId: string;
    applicationName: string;
    organizationId: string;
    organizationName: string;
    githubRepositoryId: number;
    /** What Autonoma currently calls this app's main branch. */
    trunkRef: string | undefined;
    /** What GitHub says the repository's default branch is, when it could be read. */
    defaultBranch?: string;
    /** The base preview's own ref, which a repair leaves untouched. */
    previewDeployRef?: string;
    unreadable?: string;
}

/**
 * What an install attempt did, so the callback can tell the user which of three quite
 * different things just happened instead of redirecting to the same page for all of them.
 *
 * `conflict` is the one that matters: an organization already connected to a GitHub account
 * cannot connect a second one, because every GitHub read in the platform resolves through the
 * organization's single installation. It carries the account we kept so the message can name
 * both sides.
 */
export type InstallationOutcome =
    | { status: "connected"; accountLogin: string }
    | { status: "reconnected"; accountLogin: string }
    | {
          status: "conflict";
          connectedAccountLogin: string;
          /** The installation the caller must remove on GitHub to switch accounts. */
          connectedInstallationId: number;
          /** Account kind of that installation - the manage URL is a 404 on the wrong form. */
          connectedAccountType: string;
          attemptedAccountLogin: string;
      }
    | { status: "claimed_elsewhere"; attemptedAccountLogin: string }
    /** The callback named an installation that was not created just now, so it is not this caller's to bind. */
    | { status: "stale_installation" };

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

    /**
     * Records an installation against an organization, refusing to repoint one that is already
     * connected to a different GitHub account.
     *
     * That refusal is the whole point. This used to upsert on `organizationId`, so installing on
     * a second GitHub account overwrote the first - and because every GitHub read resolves
     * through this one row, the applications linked to the previous account silently stopped
     * resolving: 404s on every read, dropped webhooks, and their repositories vanishing from
     * every picker, with nothing surfaced anywhere. Refusing keeps the working organization
     * working and lets the caller explain the limit.
     */
    /**
     * Whether GitHub will still issue a token for this installation.
     *
     * A row can name an installation that no longer works, and nothing in our own data says so:
     * an uninstall whose webhook never arrived, an installation removed by an owner, or - in any
     * environment whose database was restored from another environment - a row naming an
     * installation of a DIFFERENT GitHub App, which this app can never use. Asking GitHub is the
     * only way to tell.
     */
    private async isInstallationUsable(installationId: number): Promise<boolean> {
        try {
            // Minting a token is the probe. Building the client is NOT: `getInstallationOctokit`
            // passes a `factory` to the auth strategy, which makes it construct a client and return
            // it WITHOUT contacting GitHub - so a check that only builds the client answers "usable"
            // for an installation that does not exist. `getInstallationToken` performs the
            // installation auth for real, which is what 404s on a dead or foreign installation.
            const client = await this.githubApp.getInstallationClient(installationId);
            await client.getInstallationToken();
            return true;
        } catch (err) {
            this.logger.warn("Installation on record is no longer usable", { installationId, extra: { err } });
            return false;
        }
    }

    async handleInstallation(
        installationId: number,
        orgId: string,
        installation: InstallationDetails,
    ): Promise<InstallationOutcome> {
        const { login: accountLogin, id: accountId, type: accountType } = installation;
        this.logger.info("Handling GitHub installation", { installationId, orgId, accountLogin });

        // Before refusing a second account, make sure the first one is real. A row that GitHub will
        // not issue a token for is not a connection, and treating it as one is how an organization
        // gets permanently stuck: every install is refused in favour of an installation that does
        // not work, and the "uninstall it on GitHub" link we offer as the way out 404s, because
        // there is nothing there to uninstall. Reconciling it here turns that dead end into a
        // normal first-time connect.
        const priorInstallationId = await this.reconcileDeadInstallation(orgId, installationId);
        if (priorInstallationId != null) {
            this.logger.info("Replacing an unusable installation", {
                orgId,
                installationId,
                extra: { previousInstallationId: priorInstallationId },
            });
        }

        // The whole decision runs inside one transaction. Reading `existing` outside it let two
        // concurrent first-time installs for the same organization both see "no connection yet",
        // after which the second silently updated the first's row - the exact invariant this guard
        // exists to hold. The unique index on organization_id is the real arbiter; the read here
        // only decides which branch to take, and a loser surfaces as a constraint violation below.
        try {
            return await this.db.$transaction(async (tx) => {
                const existing = await tx.gitHubInstallation.findUnique({
                    where: { organizationId: orgId },
                    select: { installationId: true, accountLogin: true, accountType: true, status: true },
                });

                // A `deleted` row is a tombstone, not a connection: `handleUninstall` keeps the row
                // so the uninstall stays visible, but the app is gone from that account on GitHub
                // and there is no live access left to protect. Refusing on one would strand the
                // legitimate "uninstall, then move to another account" flow behind a Disconnect
                // button on a dead row. `suspended` still blocks - it comes back on unsuspend.
                const connectionIsLive = existing != null && existing.status !== "deleted";

                if (connectionIsLive && existing.installationId !== installationId) {
                    this.logger.warn("Refusing to repoint an organization to a second GitHub account", {
                        installationId,
                        orgId,
                        extra: { connectedAccountLogin: existing.accountLogin, attemptedAccountLogin: accountLogin },
                    });
                    return {
                        status: "conflict",
                        connectedAccountLogin: existing.accountLogin,
                        connectedInstallationId: existing.installationId,
                        connectedAccountType: existing.accountType,
                        attemptedAccountLogin: accountLogin,
                    };
                }

                const isFirstBinding = !connectionIsLive || existing.installationId !== installationId;
                const installedRecently = Date.now() - installation.createdAt.getTime() <= FRESH_INSTALL_WINDOW_MS;

                // Binding an installation to an organization for the first time is the only
                // operation worth replaying, so it is the only one that has to have just happened.
                // Refreshing a binding this organization already holds is exempt: that is the
                // `setup_action=update` path, where the installation is legitimately old.
                if (isFirstBinding && !installedRecently) {
                    this.logger.warn("Refusing to bind an installation that was not created recently", {
                        installationId,
                        orgId,
                        extra: { installationCreatedAt: installation.createdAt.toISOString() },
                    });
                    return { status: "stale_installation" };
                }

                // The update branch deliberately never writes `installationId` - that is what makes
                // the old silent clobber structurally impossible - so adopting a different
                // installation means dropping the tombstone and creating the row fresh.
                if (existing != null && !connectionIsLive && existing.installationId !== installationId) {
                    await tx.gitHubInstallation.delete({ where: { organizationId: orgId } });
                }

                await tx.gitHubInstallation.upsert({
                    where: { organizationId: orgId },
                    create: {
                        installationId,
                        organizationId: orgId,
                        accountLogin,
                        accountId,
                        accountType,
                        status: "active",
                    },
                    update: { accountLogin, accountId, accountType, status: "active" },
                });

                // `reconnected` means the same live installation was refreshed. Adopting a
                // tombstone's row is a new connection - the previous one was already gone.
                this.logger.info("Installation recorded", {
                    installationId,
                    orgId,
                    extra: { reconnected: connectionIsLive },
                });
                return { status: connectionIsLive ? "reconnected" : "connected", accountLogin };
            });
        } catch (error) {
            // Either the installation id is already held by another organization, or a concurrent
            // first-time install for this organization won the race. Both are conflicts the caller
            // must explain rather than retry, and both are indistinguishable to the user here.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                this.logger.warn("GitHub account is already connected to another organization", {
                    installationId,
                    orgId,
                    extra: { attemptedAccountLogin: accountLogin },
                });
                return { status: "claimed_elsewhere", attemptedAccountLogin: accountLogin };
            }
            throw error;
        }
    }

    /**
     * Asks GitHub which account an installation sits on. Used by the install callback, and by
     * the claim flow to name the account in a page the user has not signed in for yet - so it
     * must not assume the installation is on record locally.
     */
    async describeInstallation(installationId: number): Promise<InstallationDetails> {
        this.logger.info("Describing installation", { installationId });

        const client = await this.githubApp.getInstallationClient(installationId);
        const installation = await client.getInstallation(installationId);
        const account = InstallationAccountSchema.parse(installation.account);
        return { ...account, createdAt: new Date(installation.createdAt) };
    }

    /**
     * Marks the organization's recorded installation deleted when GitHub no longer honours it,
     * returning the id that was retired. A no-op when there is no row, when it is already a
     * tombstone, or when it is the very installation now being connected.
     */
    private async reconcileDeadInstallation(
        orgId: string,
        incomingInstallationId: number,
    ): Promise<number | undefined> {
        const existing = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
            select: { installationId: true, status: true },
        });
        const isOtherLiveRow =
            existing != null && existing.status !== "deleted" && existing.installationId !== incomingInstallationId;
        if (!isOtherLiveRow) return undefined;

        if (await this.isInstallationUsable(existing.installationId)) return undefined;

        await this.db.gitHubInstallation.updateMany({
            where: { organizationId: orgId, installationId: existing.installationId },
            data: { status: "deleted" },
        });
        return existing.installationId;
    }

    /**
     * The organization owning this installation, but only while the installation is live.
     *
     * The install callback uses this rather than {@link findOrganizationIdByInstallationId}: that
     * endpoint is unauthenticated, so a caller who guesses an id would otherwise be able to flip a
     * `deleted` or `suspended` installation back to `active` on an organization they have nothing
     * to do with. Resurrecting one is the harmful direction - the deploy path gates on `active`,
     * so a revived tombstone turns a clean "your GitHub installation is deleted" into repeated 404s
     * against an installation that no longer exists.
     *
     * The webhook handler deliberately keeps using the unfiltered lookup: it is signature-verified,
     * and `installation.unsuspend` has to find a suspended row to revive it.
     */
    async findActiveInstallationOwner(installationId: number): Promise<string | undefined> {
        const installation = await this.db.gitHubInstallation.findFirst({
            where: { installationId, status: "active" },
            select: { organizationId: true },
        });
        return installation?.organizationId;
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

    async postComment(orgId: string, repoFullName: string, prNumber: number, body: string): Promise<string> {
        this.logger.info("Posting PR comment", { orgId, repoFullName, prNumber });

        const client = await this.getOrgInstallationClient(orgId);
        return client.postComment(repoFullName, prNumber, body);
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

    /**
     * The repo's branch names plus its default branch, for the deploy-branch picker.
     * Bundles both GitHub reads so the caller resolves the list and the default in
     * one round trip. `truncated` is true when the repo has more branches than the
     * single page returned.
     */
    async listApplicationBranches(
        orgId: string,
        applicationId: string,
    ): Promise<{ names: string[]; defaultBranch: string; truncated: boolean }> {
        this.logger.info("Listing application branches", { orgId, applicationId });

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId: orgId },
            select: { githubRepositoryId: true },
        });
        if (app == null) throw new NotFoundError("Application not found");
        if (app.githubRepositoryId == null) throw new NotFoundError("Application is not linked to a GitHub repository");

        const client = await this.getOrgInstallationClient(orgId);
        const [repository, branches] = await Promise.all([
            client.getRepository(app.githubRepositoryId),
            client.listBranches(app.githubRepositoryId),
        ]);
        return { names: branches.names, defaultBranch: repository.defaultBranch, truncated: branches.truncated };
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

    /**
     * The repositories this org's GitHub App installation can see, each tagged with
     * the Autonoma application it is linked to. Never throws: a missing or broken
     * installation comes back as an empty list with `unavailable` explaining why, so
     * a caller can tell "no repositories" from "we could not look".
     */
    async listRepositories(orgId: string): Promise<RepositoryListing> {
        this.logger.info("Listing repositories", { orgId });

        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
        });
        // No installation means the org connected no repositories, and unlinking one clears
        // every application's repo id with it - so an empty list here is the complete answer,
        // not a failed read. `unavailable` is reserved for GitHub refusing to tell us.
        if (installation == null) return { repos: [] };

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

            return {
                repos: repos.map((repo) => {
                    const linkedApp = appByRepoId.get(repo.id);
                    return {
                        ...repo,
                        applicationId: linkedApp?.id,
                        applicationName: linkedApp?.name,
                    };
                }),
            };
        } catch (err) {
            this.logger.warn("Failed to list installation repositories - installation may be stale or uninstalled", {
                installationId: installation.installationId,
                error: err instanceof Error ? err.message : String(err),
            });
            return { repos: [], unavailable: describeListingFailure(err) };
        }
    }

    async linkRepository(orgId: string, applicationId: string, githubRepoId: number): Promise<void> {
        this.logger.info("Linking repository to application", { orgId, applicationId, githubRepoId });

        const client = await this.getOrgInstallationClient(orgId);

        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId: orgId },
        });

        if (app == null) throw new NotFoundError();

        const repository = await client.getRepository(githubRepoId);
        // First-ever link vs a re-link (or a webhook re-firing this): only the first
        // link resolves the deploy ref, so a re-link never clobbers a branch the user
        // has since chosen.
        const isFirstLink = app.githubRepositoryId == null;

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

        if (isFirstLink) {
            await this.setMainBranchToRepoDefault(applicationId, repository.defaultBranch);
        }

        this.logger.info("Repository linked to application", { applicationId, githubRepoId });
    }

    /**
     * Every application whose trunk record no longer matches its repository's default
     * branch. Before the deploy ref was split out, choosing which branch the base
     * preview built rewrote the trunk, and nothing ever put it back - so an app could
     * be left calling an integration branch "main", which silently disables merge
     * reconciliation and freezes the main-branch suite baseline.
     *
     * A ONE-OFF: nothing produces new mispins, and
     * {@link reconcileTrunkFromPushWebhook} corrects any drift from here on, so this
     * and {@link repairTrunkPin} come out once the existing backlog is repaired. They
     * are code rather than a data migration only because the comparison needs each
     * repository's default branch from GitHub, which SQL cannot ask for.
     *
     * Read-only, and reports rather than hides what it could not check: an app whose
     * default branch GitHub refuses to serve comes back with `unreadable` instead of
     * being dropped, because a short list of mispinned apps looks like a clean bill
     * of health.
     */
    async auditTrunkPins(): Promise<TrunkPinAudit[]> {
        this.logger.info("Auditing application trunk pins");

        const applications = await this.db.application.findMany({
            where: {
                disabled: false,
                githubRepositoryId: { not: null },
                organization: { githubInstallation: { status: "active" } },
            },
            orderBy: [{ organization: { name: "asc" } }, { name: "asc" }],
            select: {
                id: true,
                name: true,
                previewDeployRef: true,
                githubRepositoryId: true,
                organization: { select: { id: true, name: true } },
                mainBranch: { select: { name: true } },
                mainBranchInfo: { select: { githubRef: true } },
            },
        });

        const findings: TrunkPinAudit[] = [];
        for (let start = 0; start < applications.length; start += TRUNK_AUDIT_BATCH_SIZE) {
            const batch = applications.slice(start, start + TRUNK_AUDIT_BATCH_SIZE);
            const audited = await Promise.all(batch.map((application) => this.auditOneTrunkPin(application)));
            for (const finding of audited) {
                if (finding != null) findings.push(finding);
            }
        }

        this.logger.info("Audited application trunk pins", {
            extra: { scanned: applications.length, findings: findings.length },
        });
        return findings;
    }

    private async auditOneTrunkPin(application: {
        id: string;
        name: string;
        previewDeployRef: string | null;
        githubRepositoryId: number | null;
        organization: { id: string; name: string };
        mainBranch: { name: string } | null;
        mainBranchInfo: { githubRef: string } | null;
    }): Promise<TrunkPinAudit | undefined> {
        const githubRepositoryId = application.githubRepositoryId;
        if (githubRepositoryId == null) return undefined;

        const trunkRef = application.mainBranchInfo?.githubRef ?? application.mainBranch?.name;
        const base = {
            applicationId: application.id,
            applicationName: application.name,
            organizationId: application.organization.id,
            organizationName: application.organization.name,
            githubRepositoryId,
            trunkRef,
            previewDeployRef: application.previewDeployRef ?? undefined,
        };

        try {
            const repository = await this.getRepository(application.organization.id, githubRepositoryId);
            if (trunkRef === repository.defaultBranch) return undefined;
            return { ...base, defaultBranch: repository.defaultBranch };
        } catch (err) {
            this.logger.warn("Could not read a repository's default branch while auditing trunk pins", {
                applicationId: application.id,
                err,
            });
            return { ...base, unreadable: err instanceof Error ? err.message : String(err) };
        }
    }

    /**
     * Keeps an application's trunk pointed at its repository's real default branch,
     * off a signal we already receive.
     *
     * Every `push` payload carries `repository.default_branch`, and push fires for
     * every branch of every connected repo - so this is the cheapest continuous check
     * available, and it needs no new GitHub App event subscription.
     *
     * Reconciling was NOT safe before the deploy ref moved to its own column: the trunk
     * record doubled as the base preview's deploy branch, so correcting it would have
     * yanked the preview off a branch someone had deliberately chosen. That is the whole
     * reason {@link linkRepository} only ever resolved it on a FIRST link. With the two
     * separated the trunk is simply "whatever GitHub says the default branch is", and a
     * customer who renames theirs should not have to wait for an operator to notice.
     *
     * This is also what makes the audit/repair pair a one-off rather than a permanent
     * surface: it clears the existing backlog, and this keeps the backlog from refilling.
     *
     * Best-effort - a webhook must not fail because a bookkeeping write did.
     */
    async reconcileTrunkFromPushWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const parsed = pushRepositorySchema.safeParse(payload);
        if (!parsed.success) return;

        const { id: githubRepositoryId, default_branch: defaultBranch } = parsed.data.repository;
        if (defaultBranch == null || defaultBranch === "") return;

        try {
            const application = await this.db.application.findUnique({
                where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
                select: {
                    id: true,
                    previewDeployRef: true,
                    mainBranch: { select: { name: true } },
                    mainBranchInfo: { select: { githubRef: true } },
                },
            });
            if (application == null) return;

            const trunk = applicationBranchRefs(application).trunk;
            if (trunk === defaultBranch) return;

            this.logger.info("Trunk no longer matches the repository default branch; correcting", {
                applicationId: application.id,
                organizationId,
                extra: { from: trunk, to: defaultBranch },
            });
            await this.setMainBranchToRepoDefault(application.id, defaultBranch);
        } catch (err) {
            this.logger.warn("Could not reconcile the trunk against the repository default branch", {
                organizationId,
                err,
            });
        }
    }

    /**
     * Points one application's trunk record back at its repository's default branch.
     *
     * Deliberately does NOT touch `previewDeployRef`: the base preview keeps building
     * whatever branch it builds today, which for an app mid-onboarding is the branch
     * carrying its unmerged preview config. Only what Autonoma calls "main" changes,
     * which is the part that was wrong.
     */
    async repairTrunkPin(applicationId: string): Promise<{ from: string | undefined; to: string }> {
        this.logger.info("Repairing application trunk pin", { applicationId });

        const application = await this.db.application.findUnique({
            where: { id: applicationId },
            select: {
                organizationId: true,
                githubRepositoryId: true,
                mainBranch: { select: { name: true } },
                mainBranchInfo: { select: { githubRef: true } },
            },
        });
        if (application == null) throw new NotFoundError("Application not found");
        if (application.githubRepositoryId == null) {
            throw new ConflictError("Application is not linked to a GitHub repository");
        }

        const repository = await this.getRepository(application.organizationId, application.githubRepositoryId);
        // Reported through the same resolution the audit flagged the app by, so the
        // `from` in the result is the ref that was actually wrong.
        const from = applicationBranchRefs(application).trunk;
        await this.setMainBranchToRepoDefault(applicationId, repository.defaultBranch);

        this.logger.info("Repaired application trunk pin", {
            applicationId,
            extra: { from, to: repository.defaultBranch },
        });
        return { from, to: repository.defaultBranch };
    }

    /**
     * Resolves the application's trunk to the repo's real default branch. Called on the
     * first link, when the app still carries the seeded fallback ref and the default
     * branch first becomes known - never on a re-link, so it can't overwrite a branch
     * the user has since chosen - and by {@link repairTrunkPin}.
     *
     * The no-op check has to consider BOTH columns. They can disagree: a Vercel
     * production deploy used to correct `githubRef` alone, leaving `name` behind, and
     * two production applications are in that state today. Checking `name` only meant
     * an app whose `githubRef` was the wrong one returned early and reported success
     * while staying mispinned on the very field the audit compares.
     */
    private async setMainBranchToRepoDefault(applicationId: string, defaultBranch: string): Promise<void> {
        const app = await this.db.application.findUnique({
            where: { id: applicationId },
            select: {
                mainBranchId: true,
                mainBranch: { select: { name: true } },
                mainBranchInfo: { select: { githubRef: true } },
            },
        });
        const branchId = app?.mainBranchId;
        const alreadyResolved =
            app?.mainBranch?.name === defaultBranch && app?.mainBranchInfo?.githubRef === defaultBranch;
        if (branchId == null || alreadyResolved) return;

        this.logger.info("Setting main-branch deploy ref to repo default", {
            applicationId,
            extra: { from: app?.mainBranch?.name, to: defaultBranch },
        });
        await this.db.$transaction([
            this.db.branch.update({ where: { id: branchId }, data: { name: defaultBranch } }),
            this.db.mainBranchInfo.updateMany({ where: { branchId }, data: { githubRef: defaultBranch } }),
        ]);
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

    /**
     * Disconnects the organization: uninstalls the app on GitHub and clears every local link.
     *
     * Reports whether GitHub actually removed it. This used to be swallowed, so someone who
     * disconnected got a success message while the app was still installed on their account -
     * "I hit uninstall and nothing happens", with no way to tell that half of it had failed. We
     * still clear locally either way, because leaving the row would strand the organization, but
     * the caller can now say what is left to do.
     */
    async disconnect(orgId: string): Promise<{ removedFromGitHub: boolean; accountLogin: string }> {
        this.logger.info("Disconnecting GitHub installation", { orgId });

        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
        });

        if (installation == null) throw new NotFoundError();

        let removedFromGitHub = true;
        try {
            await this.githubApp.deleteInstallation(installation.installationId);
            this.logger.info("GitHub installation deleted from GitHub", {
                installationId: installation.installationId,
            });
        } catch (err) {
            // An installation GitHub no longer has is already in the desired state - the account is
            // not connected to anything. Anything else genuinely failed and the app is still there.
            removedFromGitHub = err instanceof GitHubInstallationUnavailableError || githubErrorStatus(err) === 404;
            this.logger.warn("Could not delete installation from GitHub - removing locally anyway", {
                installationId: installation.installationId,
                extra: { removedFromGitHub, error: err instanceof Error ? err.message : String(err) },
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

        return { removedFromGitHub, accountLogin: installation.accountLogin };
    }

    private async getOrgInstallationClient(orgId: string) {
        const installation = await this.db.gitHubInstallation.findUnique({
            where: { organizationId: orgId },
        });

        if (installation == null) {
            throw new NotFoundError(
                "This organization has no GitHub App installation on record, so Autonoma cannot reach its " +
                    "repositories. Install the Autonoma GitHub App on the organization and retry.",
            );
        }

        return this.githubApp.getInstallationClient(installation.installationId);
    }
}

/**
 * A reason a caller can act on for a failed repository listing. A revoked or
 * uninstalled app already carries one; anything else (a timeout, a GitHub
 * outage) gets a generic line rather than a raw Octokit message, which names an
 * endpoint the reader has no way to connect to their situation.
 */
function describeListingFailure(err: unknown): string {
    if (err instanceof GitHubInstallationUnavailableError) return err.message;
    const detail = err instanceof Error ? err.message : String(err);
    return (
        `Autonoma could not read this organization's repositories from GitHub, so its repository list is ` +
        `incomplete: ${detail}. This is usually transient - retry shortly. If it persists, check the Autonoma ` +
        `GitHub App is still installed on the organization at https://github.com/settings/installations.`
    );
}
