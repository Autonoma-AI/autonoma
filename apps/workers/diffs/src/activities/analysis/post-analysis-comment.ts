import { db } from "@autonoma/db";
import {
    createGitHubPrCommentStore,
    isOnboardingComplete,
    postOrUpdateCommentOnGithub,
    resolveCommentAssetBaseUrl,
} from "@autonoma/github/comment";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { S3Storage } from "@autonoma/storage";
import type { PostAnalysisPrCommentInput, PostAnalysisPrCommentOutput } from "@autonoma/workflow/activities";
import { resolvePrMeta } from "../../codebase/pr-meta";
import { resolveSnapshotMeta } from "../../codebase/snapshot-context";
import { env } from "../../env";
import { getStorage } from "../../services";
import { buildAnalysisCommentPayload } from "./analysis-comment-payload";
import { loadAnalysisCommentInput } from "./load-analysis-comment-input";

/** Screenshots are signed for the comment's lifetime; re-runs re-sign, so a week is plenty. */
const SCREENSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Post (or update in place) the authoritative analysis run's PR comment, through the shared comment system - the
 * same renderer the diffs/investigation comments use, and the DB-store updater that keeps exactly one comment per
 * `(repo, pr, analysis)`, so a re-run replaces its previous comment rather than spamming a new one. Flag-gated OFF
 * by default so it never touches real PRs until deliberately enabled. The bug cards deep-link to the branch-scoped
 * issue-detail pages (stable across snapshots), not the per-snapshot findings, and the comment carries a
 * coding-agent handoff: a paste-ready brief plus prefilled "open in <agent>" deep-links. Signed S3 report URLs are
 * never posted (they carry a token) - the comment links the in-app view; only media rides as short-lived signed URLs.
 *
 * NOTE: the handoff prompt tells the agent to call the MCP tool `get_analysis`, which is not registered on the debug
 * MCP server yet. It must land before this flag is enabled for real PRs.
 */
export async function postAnalysisPrComment(input: PostAnalysisPrCommentInput): Promise<PostAnalysisPrCommentOutput> {
    const { snapshotId } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "postAnalysisPrComment" });
    logger.info("Posting analysis PR comment");

    if (!env.ANALYSIS_PR_COMMENT_ENABLED) {
        logger.info("Skipping analysis PR comment - ANALYSIS_PR_COMMENT_ENABLED is off");
        return { status: "skipped" };
    }

    const meta = await resolveSnapshotMeta(snapshotId);
    const prMeta = await resolvePrMeta(meta);
    if (prMeta.prNumber <= 0) {
        logger.info("Skipping analysis PR comment - snapshot is not attached to a PR");
        return { status: "skipped" };
    }

    if (!isOnboardingComplete(meta.onboardingStep)) {
        logger.info("Skipping analysis PR comment - application is not fully onboarded");
        return { status: "skipped" };
    }

    // Both only need snapshotId and neither consumes the other; the run always persists a report before finalize,
    // so the null-report branch is a defensive guard, not a hot path worth gating the preview read on.
    const [report, previewUrl] = await Promise.all([
        loadAnalysisCommentInput(snapshotId, logger),
        resolvePreviewUrl(snapshotId),
    ]);
    if (report == null) {
        logger.info("Skipping analysis PR comment - no AnalysisReport persisted for this snapshot");
        return { status: "skipped" };
    }

    const payload = await buildAnalysisCommentPayload(
        {
            verdict: report.verdict,
            bugIssues: report.bugIssues,
            coverage: report.coverage,
            summary: report.summary,
        },
        {
            prNumber: prMeta.prNumber,
            repoFullName: meta.repoFullName,
            commitSha: meta.headSha,
            prUrl: buildPrUrl(meta.appSlug, prMeta.prNumber),
            issueBaseUrl: buildIssueBaseUrl(meta.appSlug, prMeta.prNumber),
            findingBaseUrl: buildFindingBaseUrl(meta.appSlug, prMeta.prNumber),
            previewUrl,
            assetBaseUrl: resolveCommentAssetBaseUrl({ appUrl: resolveAppUrl() }),
        },
        makeScreenshotSigner(getStorage(), logger),
    );

    const result = await postOrUpdateCommentOnGithub({
        client: meta.githubClient,
        store: createGitHubPrCommentStore(db, "analysis"),
        repoFullName: meta.repoFullName,
        prNumber: prMeta.prNumber,
        lastCommitSha: meta.headSha,
        payload,
        // The trigger supersedes older runs, so the latest run always owns the comment.
        staleGuard: "allow-new-head",
    });

    if (result.status === "stale_skipped") {
        logger.info("Analysis PR comment skipped - a newer run owns the comment", {
            extra: { storedHeadSha: result.storedHeadSha, incomingHeadSha: result.incomingHeadSha },
        });
        return { status: "skipped" };
    }

    logger.info("Analysis PR comment posted", {
        extra: { status: result.status, commentId: result.commentId, prNumber: prMeta.prNumber },
    });
    return { status: result.status, commentId: result.commentId };
}

/**
 * The media signer the payload builder is handed: turns an `s3://` key into a short-lived signed URL. It tags GIF
 * clips as image/gif so GitHub's image proxy animates them instead of mislabeling them as PNG; static screenshots
 * stay image/png. A signing failure is contained (logged + undefined) so a broken screenshot never sinks the
 * comment. Kept injectable so the builder stays hermetically testable (no S3 dependency).
 */
function makeScreenshotSigner(storage: S3Storage, logger: Logger): (s3Key: string) => Promise<string | undefined> {
    return async (s3Key) => {
        const contentType = s3Key.endsWith(".gif") ? "image/gif" : "image/png";
        try {
            return await storage.getSignedUrl(s3Key, SCREENSHOT_TTL_SECONDS, contentType);
        } catch (err) {
            logger.warn("Failed to sign analysis screenshot for the PR comment", { extra: { s3Key, err } });
            return undefined;
        }
    };
}

/** The branch's preview environment URL, if it has a web deployment. */
async function resolvePreviewUrl(snapshotId: string): Promise<string | undefined> {
    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapshotId },
        select: {
            branch: { select: { deployment: { select: { webDeployment: { select: { url: true } } } } } },
        },
    });
    return snapshot?.branch.deployment?.webDeployment?.url;
}

/** Absolute URL of the in-app PR overview page; the "Open in Autonoma" CTA lands here. */
function buildPrUrl(appSlug: string, prNumber: number): string {
    const path = `/app/${encodeURIComponent(appSlug)}/pull-requests/${prNumber}/`;
    return new URL(path, resolveAppUrl()).toString();
}

/**
 * Absolute base URL of the in-app issue-detail pages for this PR; each bug card appends its `issueId`. Issues are
 * branch-scoped (they evolve across snapshots), so the route lives at the PR level, above snapshots - fixing the
 * old finding-key path that pointed at a single snapshot's finding.
 */
function buildIssueBaseUrl(appSlug: string, prNumber: number): string {
    const path = `/app/${encodeURIComponent(appSlug)}/pull-requests/${prNumber}/issues`;
    return new URL(path, resolveAppUrl()).toString();
}

/**
 * Absolute base URL of the in-app per-snapshot finding pages for this PR; a card's replay link appends
 * `<snapshotId>/findings/<findingKey>`. An issue's card links here to the ONE run the Reporter designated as its
 * clearest reproduction, while the card's title links to the branch-scoped issue itself.
 */
function buildFindingBaseUrl(appSlug: string, prNumber: number): string {
    const path = `/app/${encodeURIComponent(appSlug)}/pull-requests/${prNumber}/snapshots`;
    return new URL(path, resolveAppUrl()).toString();
}

/** Resolve the app's base URL from the deployment env, matching how other PR-comment jobs build their links. */
function resolveAppUrl(): string {
    const sentryEnv = env.SENTRY_ENV;
    if (sentryEnv === "beta") return "https://beta.autonoma.app";
    if (sentryEnv.startsWith("alpha-")) {
        const alphaHash = sentryEnv.slice("alpha-".length);
        return `https://${alphaHash}.alpha.autonoma.app`;
    }
    return "https://autonoma.app";
}
