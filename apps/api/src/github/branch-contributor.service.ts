import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { contributorKey, type ResolvedContributor, resolveContributorsFromCommits } from "@autonoma/github";
import { z } from "zod";
import { Service } from "../routes/service";
import type { GitHubInstallationService } from "./github-installation.service";

/** The `pull_request` webhook fields the contributor refresh reads (opener + repo + PR number). */
const prWebhookSchema = z.object({
    pull_request: z.object({
        number: z.number(),
        user: z.object({ login: z.string().optional() }).nullish(),
    }),
    repository: z.object({ id: z.number(), full_name: z.string() }),
});

/**
 * Identifies a PR's branch either by the linked application or directly by its GitHub repository id (the
 * webhook path, which carries `repository.id`). One of the two must be present.
 */
export interface ResolveBranchContributorsParams {
    organizationId: string;
    prNumber: number;
    applicationId?: string;
    githubRepositoryId?: number;
    /** The PR opener's GitHub login; always included in the result flagged `isOpener`. */
    openerLogin?: string;
}

export interface ResolveFixingPushAuthorsParams {
    organizationId: string;
    applicationId?: string;
    githubRepositoryId?: number;
    snapshotOrHeadSha: string;
}

/** Where a resolved contributor set is written: the repo/PR it belongs to, plus the tracked branch pointer. */
interface PersistTarget {
    organizationId: string;
    repoFullName: string;
    prNumber: number;
    branchId?: string;
}

/**
 * Per-developer attribution for the stickiness merge-gate. A PR has more than one author, so its outcome
 * must be attributable to ALL of them - not just the opener. This service resolves a branch's full
 * contributor set (commit authors + `Co-authored-by:` co-authors + the opener) and persists it to
 * `BranchContributor`.
 */
export class BranchContributorService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly github: GitHubInstallationService,
    ) {
        super();
    }

    /**
     * Resolve the deduped contributor set for a PR: every commit's author (login when GitHub linked the
     * email to an account) plus every `Co-authored-by:` trailer (kept as name/email, unresolved), with the
     * opener merged in.
     */
    async resolveBranchContributors(params: ResolveBranchContributorsParams): Promise<ResolvedContributor[]> {
        this.logger.info("Resolving branch contributors", {
            organizationId: params.organizationId,
            extra: { prNumber: params.prNumber, applicationId: params.applicationId },
        });

        const applicationId = await this.resolveApplicationId(params);
        const commits = await this.github.listApplicationPullRequestCommits(
            params.organizationId,
            applicationId,
            params.prNumber,
        );
        const contributors = resolveContributorsFromCommits(commits, { openerLogin: params.openerLogin });

        this.logger.info("Resolved branch contributors", {
            organizationId: params.organizationId,
            extra: { prNumber: params.prNumber, contributorCount: contributors.length },
        });
        return contributors;
    }

    /**
     * Webhook entry for `pull_request.opened/synchronize/reopened/ready_for_review/closed`: resolve and
     * persist the PR's contributor set.
     */
    async refreshFromWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const parsed = prWebhookSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("Branch contributors: could not parse PR payload", {
                organizationId,
                extra: { issues: parsed.error.issues },
            });
            return;
        }
        const { pull_request: pr, repository: repo } = parsed.data;
        this.logger.info("Branch contributors: refreshFromWebhook", {
            organizationId,
            extra: { prNumber: pr.number, repoFullName: repo.full_name },
        });

        const application = await this.db.application.findFirst({
            where: { organizationId, githubRepositoryId: repo.id },
            select: { id: true },
        });
        if (application == null) {
            this.logger.info("Branch contributors: no application linked to repo, skipping", {
                organizationId,
                extra: { repoId: repo.id },
            });
            return;
        }

        const tracked = await this.db.featureBranchInfo.findUnique({
            where: { applicationId_prNumber: { applicationId: application.id, prNumber: pr.number } },
            select: { branchId: true },
        });
        if (tracked == null) {
            this.logger.info("Branch contributors: PR not tracked yet, skipping", {
                applicationId: application.id,
                extra: { prNumber: pr.number },
            });
            return;
        }

        try {
            const commits = await this.github.listApplicationPullRequestCommits(
                organizationId,
                application.id,
                pr.number,
            );
            const contributors = resolveContributorsFromCommits(commits, { openerLogin: pr.user?.login });

            await this.persistBranchContributors(
                { organizationId, repoFullName: repo.full_name, prNumber: pr.number, branchId: tracked.branchId },
                contributors,
            );
        } catch (err) {
            this.logger.warn("Branch contributors: refresh failed, skipping (non-critical enrichment)", {
                applicationId: application.id,
                extra: { prNumber: pr.number, repoFullName: repo.full_name },
                err,
            });
        }
    }

    /**
     * Fix-attribution primitive: the commit authors (plus `Co-authored-by:` co-authors) of the push a fix
     * landed on.
     */
    async resolveFixingPushAuthors(params: ResolveFixingPushAuthorsParams): Promise<ResolvedContributor[]> {
        this.logger.info("Resolving fixing-push authors", {
            organizationId: params.organizationId,
            extra: { snapshotOrHeadSha: params.snapshotOrHeadSha, applicationId: params.applicationId },
        });

        const applicationId = await this.resolveApplicationId(params);
        const sha = await this.resolveHeadSha(params.snapshotOrHeadSha);
        const commit = await this.github.getApplicationCommit(params.organizationId, applicationId, sha);

        const authors = resolveContributorsFromCommits([commit]);

        this.logger.info("Resolved fixing-push authors", {
            organizationId: params.organizationId,
            extra: { sha, authorCount: authors.length },
        });
        return authors;
    }

    /**
     * Upsert one row per contributor, keyed by (repo, PR, contributorKey). Accumulates across pushes: a new
     * push adds newly seen authors and refreshes known ones; an author whose commit was later force-pushed
     * away is intentionally kept as attribution history.
     */
    private async persistBranchContributors(ctx: PersistTarget, contributors: ResolvedContributor[]): Promise<void> {
        if (contributors.length === 0) {
            this.logger.info("Branch contributors: nothing to persist", {
                organizationId: ctx.organizationId,
                extra: { repoFullName: ctx.repoFullName, prNumber: ctx.prNumber },
            });
            return;
        }

        await this.db.$transaction(
            contributors.map((contributor) => {
                const key = contributorKey(contributor);
                return this.db.branchContributor.upsert({
                    where: {
                        repoFullName_prNumber_contributorKey: {
                            repoFullName: ctx.repoFullName,
                            prNumber: ctx.prNumber,
                            contributorKey: key,
                        },
                    },
                    create: {
                        organizationId: ctx.organizationId,
                        repoFullName: ctx.repoFullName,
                        prNumber: ctx.prNumber,
                        branchId: ctx.branchId,
                        login: contributor.login,
                        displayName: contributor.displayName,
                        email: contributor.email,
                        isOpener: contributor.isOpener,
                        contributorKey: key,
                    },
                    update: {
                        branchId: ctx.branchId,
                        login: contributor.login,
                        displayName: contributor.displayName,
                        email: contributor.email,
                        isOpener: contributor.isOpener ? true : undefined,
                    },
                });
            }),
        );

        this.logger.info("Branch contributors: persisted", {
            organizationId: ctx.organizationId,
            extra: { repoFullName: ctx.repoFullName, prNumber: ctx.prNumber, count: contributors.length },
        });
    }

    private async resolveApplicationId(params: {
        organizationId: string;
        applicationId?: string;
        githubRepositoryId?: number;
    }): Promise<string> {
        if (params.applicationId != null) {
            const application = await this.db.application.findFirst({
                where: { id: params.applicationId, organizationId: params.organizationId },
                select: { id: true },
            });
            if (application == null) throw new NotFoundError("Application not found");
            return application.id;
        }
        if (params.githubRepositoryId != null) {
            const application = await this.db.application.findFirst({
                where: { organizationId: params.organizationId, githubRepositoryId: params.githubRepositoryId },
                select: { id: true },
            });
            if (application == null) throw new NotFoundError("No application linked to that repository");
            return application.id;
        }
        throw new BadRequestError("Provide either applicationId or githubRepositoryId");
    }

    /** A BranchSnapshot id resolves to its head SHA; any other value is treated as a raw commit SHA. */
    private async resolveHeadSha(snapshotOrHeadSha: string): Promise<string> {
        const snapshot = await this.db.branchSnapshot.findUnique({
            where: { id: snapshotOrHeadSha },
            select: { headSha: true },
        });
        if (snapshot?.headSha != null) return snapshot.headSha;
        return snapshotOrHeadSha;
    }
}
