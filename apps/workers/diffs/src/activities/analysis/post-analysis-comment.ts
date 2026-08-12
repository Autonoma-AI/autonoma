import type { PrismaClient } from "@autonoma/db";
import {
    createGitHubPrCommentStore,
    hasGoneLive,
    postOrUpdateCommentOnGithub,
    resolveCommentAssetBaseUrl,
} from "@autonoma/github/comment";
import { logger as rootLogger } from "@autonoma/logger";
import type { S3Storage } from "@autonoma/storage";
import { ANALYSIS_VERDICT, type AnalysisRunOutcome } from "@autonoma/types";
import { resolveRunTarget } from "../../codebase/run-target";
import type { GitHubAccess, SnapshotMeta } from "../../codebase/snapshot-context";
import { env } from "../../env";
import { buildAnalysisCommentPayload } from "./analysis-comment-payload";
import { loadAnalysisCommentInput } from "./load-analysis-comment-input";
import { isMergeGateEnabledForOrg } from "./merge-gate-enabled";

/** Screenshots are signed for the comment's lifetime; re-runs re-sign, so a week is plenty. */
const SCREENSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The verdict that blocks the PR; drives whether the merge-gate skip callout is added to the comment. */
const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;

/**
 * Post (or update in place) the authoritative analysis run's PR comment, through the shared comment system - the
 * same renderer the diffs/investigation comments use, and the DB-store updater that keeps exactly one comment per
 * `(repo, pr, analysis)`, so a re-run replaces its previous comment rather than spamming a new one. The bug cards
 * deep-link to the branch-scoped issue-detail pages (stable across snapshots), not the per-snapshot findings; the
 * body groups the run's coverage gaps by owner (what the reader must fix, then what is ours); and the comment carries
 * a coding-agent handoff: a paste-ready brief, prefilled "open in <agent>" deep-links, and the `get_analysis` MCP
 * call that serves the same issues live without a login. Signed S3 report URLs are never posted (they carry a token)
 * - the comment links the in-app view; only media rides as short-lived signed URLs.
 *
 * `ANALYSIS_PR_COMMENT_ENABLED` is a kill switch, on by default.
 */
export async function postAnalysisComment({
    db,
    github,
    storage,
    meta,
    outcome,
}: {
    db: PrismaClient;
    github: GitHubAccess;
    storage: S3Storage;
    meta: SnapshotMeta;
    outcome: AnalysisRunOutcome;
}): Promise<{ status: "posted" | "updated" | "skipped"; commentId?: string }> {
    const logger = rootLogger.child({ name: "postAnalysisComment", snapshotId: meta.snapshotId });
    logger.info("Posting analysis PR comment");

    if (!env.ANALYSIS_PR_COMMENT_ENABLED) {
        logger.info("Skipping analysis PR comment - ANALYSIS_PR_COMMENT_ENABLED is off");
        return { status: "skipped" };
    }

    if (outcome.kind !== "succeeded") {
        logger.info("Skipping analysis PR comment - the run did not succeed");
        return { status: "skipped" };
    }

    const target = await resolveRunTarget({
        branchId: meta.branchId,
        githubRepositoryId: meta.githubRepositoryId,
        githubClient: github.githubClient,
    });
    if (target.kind !== "pull_request") {
        logger.info("Skipping analysis PR comment - a main-branch run has no pull request to comment on", {
            extra: { branchName: target.branchName },
        });
        return { status: "skipped" };
    }

    if (!hasGoneLive(meta.onboardingStep)) {
        logger.info("Skipping analysis PR comment - application is not fully onboarded");
        return { status: "skipped" };
    }

    // Both only need snapshotId and neither consumes the other; the run always persists a report before finalize,
    // so the null-report branch is a defensive guard, not a hot path worth gating the preview read on.
    const [report, previewUrl] = await Promise.all([
        loadAnalysisCommentInput(meta.snapshotId),
        resolvePreviewUrl(db, meta.snapshotId),
    ]);
    if (report == null) {
        logger.info("Skipping analysis PR comment - no AnalysisReport persisted for this snapshot");
        return { status: "skipped" };
    }

    const mergeGateBlocking = report.verdict === CLIENT_BUG && (await isMergeGateEnabledForOrg(meta.organizationId));

    const payload = await buildAnalysisCommentPayload(
        {
            testCount: report.testCount,
            bugIssues: report.bugIssues,
            coverage: report.coverage,
            coverageIssues: report.coverageIssues,
            mergeGateBlocking,
            title: report.title,
            headline: report.headline,
            flows: report.flows,
        },
        {
            prNumber: target.prNumber,
            repoFullName: github.repoFullName,
            commitSha: meta.headSha,
            appSlug: meta.appSlug,
            previewUrl,
            appBaseUrl: resolveAppUrl(),
            assetBaseUrl: resolveCommentAssetBaseUrl({ appUrl: resolveAppUrl() }),
        },
        makeScreenshotSigner(storage, meta.snapshotId),
    );

    const result = await postOrUpdateCommentOnGithub({
        client: github.githubClient,
        store: createGitHubPrCommentStore(db, "analysis"),
        repoFullName: github.repoFullName,
        prNumber: target.prNumber,
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
        extra: { status: result.status, commentId: result.commentId, prNumber: target.prNumber },
    });
    return { status: result.status, commentId: result.commentId };
}

/**
 * The media signer the payload builder is handed: turns an `s3://` key into a short-lived signed URL. It tags GIF
 * clips as image/gif so GitHub's image proxy animates them instead of mislabeling them as PNG; static screenshots
 * stay image/png. A signing failure is contained (logged + undefined) so a broken screenshot never sinks the
 * comment. Kept injectable so the builder stays hermetically testable (no S3 dependency).
 */
function makeScreenshotSigner(storage: S3Storage, snapshotId: string): (s3Key: string) => Promise<string | undefined> {
    const logger = rootLogger.child({ name: "makeScreenshotSigner", snapshotId });
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
async function resolvePreviewUrl(db: PrismaClient, snapshotId: string): Promise<string | undefined> {
    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapshotId },
        select: {
            branch: { select: { deployment: { select: { webDeployment: { select: { url: true } } } } } },
        },
    });
    return snapshot?.branch.deployment?.webDeployment?.url;
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
