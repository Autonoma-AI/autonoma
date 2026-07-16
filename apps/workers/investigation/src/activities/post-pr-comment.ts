import { getCheckpointSummaries, healthyHeadlineFromSummary, statsFromSummary } from "@autonoma/checkpoint";
import { db } from "@autonoma/db";
import {
    createGitHubPrCommentStore,
    isOnboardingComplete,
    postOrUpdateCommentOnGithub,
    resolveCommentAssetBaseUrl,
} from "@autonoma/github/comment";
import { logger as rootLogger } from "@autonoma/logger";
import type { PostInvestigationPrCommentInput, PostInvestigationPrCommentOutput } from "@autonoma/workflow/activities";
import { resolvePrMeta } from "../codebase/pr-meta";
import { resolveSnapshotMeta } from "../codebase/resolve";
import { env } from "../env";
import { getStorage } from "../services";
import { buildInvestigationCommentPayload } from "./investigation-comment-payload";

/** Screenshots are signed for the comment's lifetime; re-runs re-sign, so a week is plenty. */
const SCREENSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Post (or update in place) the investigation-results comment on the PR, through the shared comment system:
 * the same renderer the diffs comment uses, and the DB-store updater that keeps exactly one comment per
 * (repo, pr, kind) - so a re-run always replaces the previous comment rather than spamming a new one. Flag-gated
 * OFF by default so it never touches real PRs until deliberately enabled. Signed S3 report URLs are never posted
 * (they carry a token) - the comment links the in-app investigation view; only screenshots are embedded as
 * short-lived signed image URLs.
 */
export async function postInvestigationPrComment(
    input: PostInvestigationPrCommentInput,
): Promise<PostInvestigationPrCommentOutput> {
    const { snapshotId } = input;
    const logger = rootLogger.child({ name: "postInvestigationPrComment", extra: { snapshotId } });
    logger.info("Posting investigation PR comment");

    if (!env.INVESTIGATION_PR_COMMENT_ENABLED) {
        logger.info("Skipping investigation PR comment - INVESTIGATION_PR_COMMENT_ENABLED is off");
        return { status: "skipped" };
    }

    const meta = await resolveSnapshotMeta(snapshotId);
    const prMeta = await resolvePrMeta(meta);
    if (prMeta.prNumber <= 0) {
        logger.info("Skipping investigation PR comment - snapshot is not attached to a PR");
        return { status: "skipped" };
    }

    if (!isOnboardingComplete(meta.onboardingStep)) {
        logger.info("Skipping investigation PR comment - application is not fully onboarded");
        return { status: "skipped" };
    }

    // The investigation runs on a detached shadow snapshot, but its in-app report is navigable under the PARENT
    // (primary) checkpoint - so report/finding links must use the checkpoint id (the shadow is not a navigable
    // checkpoint), and the comment's stats mirror that primary checkpoint (dashboard parity), never the twin's.
    // previewUrl and the primary checkpoint are independent reads of this snapshot; resolve them together.
    const [previewUrl, primary] = await Promise.all([
        resolvePreviewUrl(snapshotId),
        resolvePrimaryCheckpoint(snapshotId),
    ]);
    // The summary and the diffs-job status both hang off the primary checkpoint but not off each other.
    const [summaries, diffsJob] = await Promise.all([
        getCheckpointSummaries(db, [{ id: primary.id, status: primary.status }], logger),
        db.diffsJob.findUnique({ where: { snapshotId: primary.id }, select: { status: true } }),
    ]);
    const summary = summaries.get(primary.id);
    const stats = summary != null ? statsFromSummary(summary) : undefined;

    const storage = getStorage();
    const payload = await buildInvestigationCommentPayload(
        input.results,
        {
            prNumber: prMeta.prNumber,
            commitSha: meta.headSha,
            prUrl: buildPrUrl(meta.appSlug, prMeta.prNumber),
            reportBaseUrl: buildReportBaseUrl(meta.appSlug, prMeta.prNumber, primary.id),
            previewUrl,
            assetBaseUrl: resolveCommentAssetBaseUrl({ appUrl: resolveAppUrl() }),
            repoFullName: meta.repoFullName,
            stats,
            // The findings-clean headline defers to the primary checkpoint (findings first, checkpoint second).
            checkpointHeadline: healthyHeadlineFromSummary(summary, diffsJob?.status),
        },
        async (s3Url) => {
            // Serve the correct content type so GitHub's image proxy renders the animated GIF clip (client bugs)
            // instead of mislabeling it as a PNG; static screenshots stay image/png.
            const contentType = s3Url.endsWith(".gif") ? "image/gif" : "image/png";
            try {
                return await storage.getSignedUrl(s3Url, SCREENSHOT_TTL_SECONDS, contentType);
            } catch (err) {
                logger.warn("Failed to sign investigation screenshot for the PR comment", { extra: { s3Url, err } });
                return undefined;
            }
        },
    );

    const result = await postOrUpdateCommentOnGithub({
        client: meta.githubClient,
        store: createGitHubPrCommentStore(db, "investigation"),
        repoFullName: meta.repoFullName,
        prNumber: prMeta.prNumber,
        lastCommitSha: meta.headSha,
        payload,
        // The investigation workflow already supersedes older runs, so the latest run always owns the comment.
        staleGuard: "allow-new-head",
    });

    if (result.status === "stale_skipped") {
        logger.info("Investigation PR comment skipped - a newer run owns the comment", {
            extra: { storedHeadSha: result.storedHeadSha, incomingHeadSha: result.incomingHeadSha },
        });
        return { status: "skipped" };
    }

    logger.info("Investigation PR comment posted", {
        extra: { status: result.status, commentId: result.commentId, prNumber: prMeta.prNumber },
    });
    return { status: result.status, commentId: result.commentId };
}

/** The branch's preview environment URL, if it has a web deployment. */
async function resolvePreviewUrl(snapshotId: string): Promise<string | undefined> {
    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapshotId },
        select: {
            branch: { select: { deployment: { select: { webDeployment: { select: { url: true } } } } } },
        },
    });
    return snapshot?.branch.deployment?.webDeployment?.url ?? undefined;
}

/**
 * The investigation runs on a detached shadow snapshot, but its in-app report is navigable under the PARENT
 * (primary) checkpoint (the shadow is not itself a navigable checkpoint). Resolve the primary checkpoint's id
 * and status - the id anchors the report/finding links, and both feed the checkpoint summary the comment's
 * stats come from. Falls back to this snapshot when it has no investigation parent (already a checkpoint).
 */
async function resolvePrimaryCheckpoint(snapshotId: string): Promise<{ id: string; status: string }> {
    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapshotId },
        select: {
            status: true,
            investigationParent: { select: { id: true, status: true } },
        },
    });
    const parent = snapshot?.investigationParent;
    if (parent != null) return { id: parent.id, status: parent.status };
    return { id: snapshotId, status: snapshot?.status ?? "unknown" };
}

/** Absolute URL of the in-app PR overview page; the "Open in Autonoma" CTA lands here. */
function buildPrUrl(appSlug: string, prNumber: number): string {
    const path = `/app/${encodeURIComponent(appSlug)}/pull-requests/${prNumber}/`;
    return new URL(path, resolveAppUrl()).toString();
}

/** Absolute base URL of the in-app investigation report for this snapshot; per-finding links append the slug. */
function buildReportBaseUrl(appSlug: string, prNumber: number, snapshotId: string): string {
    const path = `/app/${encodeURIComponent(appSlug)}/pull-requests/${prNumber}/snapshots/${snapshotId}/investigation`;
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
