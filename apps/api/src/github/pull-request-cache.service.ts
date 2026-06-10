import type { PrismaClient, PullRequestCacheState } from "@autonoma/db";
import { z } from "zod";
import { env } from "../env";
import { Service } from "../routes/service";
import type { GitHubInstallationService } from "./github-installation.service";

// Only the fields we cache, parsed defensively from the raw GitHub pull_request webhook.
const webhookPullRequestEventSchema = z.object({
    pull_request: z.object({
        number: z.number(),
        title: z.string(),
        state: z.string(),
        merged: z.boolean().optional(),
        user: z.object({ login: z.string().optional() }).nullish(),
        updated_at: z.string(),
    }),
    repository: z.object({
        id: z.number(),
    }),
});

type WebhookPullRequest = z.infer<typeof webhookPullRequestEventSchema>["pull_request"];

function mapWebhookState(pr: WebhookPullRequest): PullRequestCacheState {
    if (pr.merged === true) return "merged";
    return pr.state === "closed" ? "closed" : "open";
}

/**
 * Owns the Postgres cache of GitHub PR metadata on FeatureBranchInfo. Two entry points:
 *
 *  - `updateFromWebhook` - the freshness mechanism. Called from the GitHub webhook handler
 *    on pull_request events; writes the latest PR metadata for tracked PRs.
 *  - `kickOff` / `revalidate` - a polite, fire-and-forget backstop kicked off when the PR
 *    list is read. Throttled entirely via Postgres (`min(prCachedAt)`), so it is correct
 *    across pods and pod restarts with no in-memory state. Bulk-lists open PRs (one
 *    ETag-conditional request) and backfills a bounded number of stale/uncached rows.
 *
 * Reusable: depends only on a PrismaClient and the GitHubInstallationService, so the
 * webhook router, BranchesService, and any future caller share one implementation.
 */
export class PullRequestCacheService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly github: GitHubInstallationService,
    ) {
        super();
    }

    async updateFromWebhook(organizationId: string, payload: Record<string, unknown>): Promise<void> {
        const parsed = webhookPullRequestEventSchema.safeParse(payload);
        if (!parsed.success) {
            this.logger.warn("PR cache: webhook payload missing pull_request or repository", {
                extra: { issues: parsed.error.issues },
            });
            return;
        }
        const { pull_request: pr, repository: repo } = parsed.data;

        this.logger.info("Updating PR cache from webhook", { organizationId, extra: { prNumber: pr.number } });

        const app = await this.db.application.findFirst({
            where: { organizationId, githubRepositoryId: repo.id },
            select: { id: true },
        });
        if (app == null) {
            this.logger.info("PR cache: no application linked to repo, skipping", {
                extra: { repoId: repo.id },
            });
            return;
        }

        // The PR list only shows tracked PRs (those with a FeatureBranchInfo row). We cannot
        // synthesize a Branch/branchId from a webhook, so we skip PRs Autonoma is not tracking.
        const existing = await this.db.featureBranchInfo.findUnique({
            where: { applicationId_prNumber: { applicationId: app.id, prNumber: pr.number } },
            select: { branchId: true },
        });
        if (existing == null) {
            this.logger.info("PR cache: no tracked branch for PR yet, skipping", {
                applicationId: app.id,
                extra: { prNumber: pr.number },
            });
            return;
        }

        await this.db.featureBranchInfo.update({
            where: { applicationId_prNumber: { applicationId: app.id, prNumber: pr.number } },
            data: {
                prTitle: pr.title,
                prState: mapWebhookState(pr),
                prAuthorLogin: pr.user?.login ?? null,
                prUpdatedAt: new Date(pr.updated_at),
                prCachedAt: new Date(),
            },
        });

        this.logger.info("PR cache updated from webhook", { applicationId: app.id, extra: { prNumber: pr.number } });
    }

    /** Fire-and-forget revalidation. Never blocks the caller; logs and swallows failures. */
    kickOff(applicationId: string, organizationId: string): void {
        void this.revalidate(applicationId, organizationId).catch((err) => {
            this.logger.warn("PR cache revalidation failed", {
                applicationId,
                extra: { error: err instanceof Error ? err.message : String(err) },
            });
        });
    }

    async revalidate(applicationId: string, organizationId: string): Promise<void> {
        // Throttle the bulk open-PR refresh to ~once per window per app, gated on the OLDEST
        // cache write across the app's tracked PRs. Every revalidation stamps prCachedAt on
        // *every* tracked row (below), so the oldest advances each window. This is NOT
        // defeated by webhooks: a webhook only bumps individual rows newer, while the oldest
        // stays at the last full revalidation, so the gate releases once the window elapses.
        // (Gating on the newest write was wrong - constant webhook traffic kept it "fresh"
        // forever and the bulk refresh never ran, leaving open PRs on the branch-name
        // fallback.)
        const windowMs = env.GITHUB_PR_CACHE_REVALIDATE_WINDOW_MINUTES * 60_000;
        const cutoff = Date.now() - windowMs;

        const tracked = await this.db.featureBranchInfo.findMany({
            where: { applicationId },
            select: { prNumber: true, prCachedAt: true },
        });
        if (tracked.length === 0) return;

        const hasUncached = tracked.some((t) => t.prCachedAt == null);
        const oldestCachedAt = tracked.reduce<Date | undefined>((min, t) => {
            if (t.prCachedAt == null) return min;
            return min == null || t.prCachedAt < min ? t.prCachedAt : min;
        }, undefined);
        const isFresh = !hasUncached && oldestCachedAt != null && oldestCachedAt.getTime() > cutoff;
        if (isFresh) {
            this.logger.debug("PR cache fresh, skipping revalidation", { applicationId });
            return;
        }

        this.logger.info("Revalidating PR cache (open PRs only)", { applicationId });

        const now = new Date();
        const result = await this.github.listApplicationPullRequests(organizationId, applicationId);

        if (result.unchanged) {
            // Open-PR list unchanged since the last fetch. Stamp EVERY tracked row so the
            // gate (oldest prCachedAt) advances; otherwise uncached closed PRs would keep it
            // open and we'd revalidate on every read.
            await this.db.featureBranchInfo.updateMany({
                where: { applicationId },
                data: { prCachedAt: now },
            });
            return;
        }

        // Refresh metadata for tracked PRs that are currently OPEN (present in the list).
        const trackedNumbers = new Set(tracked.map((t) => t.prNumber));
        const openPullRequests = result.pullRequests.filter((pr) => trackedNumbers.has(pr.number));
        const openNumbers = openPullRequests.map((pr) => pr.number);
        const openUpdates = openPullRequests.map((pr) =>
            this.db.featureBranchInfo.update({
                where: { applicationId_prNumber: { applicationId, prNumber: pr.number } },
                data: {
                    prTitle: pr.title,
                    prState: pr.state,
                    prAuthorLogin: pr.authorLogin ?? null,
                    prUpdatedAt: new Date(pr.updatedAt),
                    prCachedAt: now,
                },
            }),
        );

        // Stamp the remaining tracked rows (closed/merged, or open beyond the list page) so
        // the freshness gate advances. We deliberately do NOT fetch their metadata - closed
        // PRs are terminal and captured by the pull_request.closed webhook; this only marks
        // them "checked" so they stop forcing a revalidation on every read.
        const stampRest = this.db.featureBranchInfo.updateMany({
            where: { applicationId, prNumber: { notIn: openNumbers } },
            data: { prCachedAt: now },
        });

        await this.db.$transaction([...openUpdates, stampRest]);
    }
}
