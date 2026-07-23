import { type Prisma, db } from "@autonoma/db";
import type { AppHealthVerdict } from "@autonoma/diffs/analysis";
import {
    createGitHubPrCommentStore,
    isOnboardingComplete,
    postOrUpdateCommentOnGithub,
    resolveCommentAssetBaseUrl,
} from "@autonoma/github/comment";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { S3Storage } from "@autonoma/storage";
import {
    ANALYSIS_VERDICT,
    type CoverageSummary,
    coverageSummarySchema,
    investigationEvidenceSchema,
} from "@autonoma/types";
import type { PostAnalysisPrCommentInput, PostAnalysisPrCommentOutput } from "@autonoma/workflow/activities";
import { z } from "zod";
import { resolvePrMeta } from "../../codebase/pr-meta";
import { resolveSnapshotMeta } from "../../codebase/snapshot-context";
import { env } from "../../env";
import { getStorage } from "../../services";
import { type AnalysisClientBugFinding, buildAnalysisCommentPayload } from "./analysis-comment-payload";

/** Screenshots are signed for the comment's lifetime; re-runs re-sign, so a week is plenty. */
const SCREENSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The only finding category rendered as a card; coverage findings are summarized in the coverage line. */
const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;

const evidenceListSchema = z.array(investigationEvidenceSchema);

/**
 * Post (or update in place) the authoritative analysis run's PR comment, through the shared comment system - the
 * same renderer the diffs/investigation comments use, and the DB-store updater that keeps exactly one comment per
 * `(repo, pr, analysis)`, so a re-run replaces its previous comment rather than spamming a new one. Flag-gated OFF
 * by default so it never touches real PRs until deliberately enabled. Anchors directly to the branch's real
 * pending snapshot - the run reconciled that snapshot, so the report/finding links use it with no checkpoint
 * indirection. Signed S3 report URLs are never posted (they carry a token) - the comment links the in-app
 * analysis view; only screenshots ride as short-lived signed image URLs.
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

    // Both only need snapshotId and neither consumes the other; the reconciler always persisted a report before
    // finalize ran, so the null-report branch is a defensive guard, not a hot path worth gating the preview read on.
    const [report, previewUrl] = await Promise.all([loadReport(snapshotId), resolvePreviewUrl(snapshotId)]);
    if (report == null) {
        logger.info("Skipping analysis PR comment - no AnalysisReport persisted for this snapshot");
        return { status: "skipped" };
    }

    const payload = await buildAnalysisCommentPayload(
        {
            verdict: report.verdict,
            clientBugs: report.clientBugs,
            coverage: report.coverage,
            narration: report.narration,
        },
        {
            prNumber: prMeta.prNumber,
            commitSha: meta.headSha,
            prUrl: buildPrUrl(meta.appSlug, prMeta.prNumber),
            reportBaseUrl: buildReportBaseUrl(meta.appSlug, prMeta.prNumber, snapshotId),
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
 * clips (client bugs) as image/gif so GitHub's image proxy animates them instead of mislabeling them as PNG;
 * static screenshots stay image/png. A signing failure is contained (logged + undefined) so a broken screenshot
 * never sinks the comment. Kept injectable so the builder stays hermetically testable (no S3 dependency).
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

interface LoadedReport {
    verdict: AppHealthVerdict;
    clientBugs: AnalysisClientBugFinding[];
    coverage?: CoverageSummary;
    narration?: string;
}

/**
 * Read the persisted run: the app-health verdict, the constrained narration, the coverage-plane summary, and the
 * `client_bug` findings (the only ones the comment cards). The `coverage` blob and each finding's `evidence` are
 * JSON columns, so they are validated at the read boundary and degrade to absent/empty on a shape mismatch rather
 * than throwing. Returns undefined when the snapshot has no report (nothing to comment on).
 */
async function loadReport(snapshotId: string): Promise<LoadedReport | undefined> {
    const report = await db.analysisReport.findUnique({
        where: { snapshotId },
        select: {
            verdict: true,
            narration: true,
            coverage: true,
            findings: {
                where: { category: CLIENT_BUG },
                orderBy: { displayOrder: "asc" },
                select: {
                    findingKey: true,
                    headline: true,
                    whatHappened: true,
                    remediation: true,
                    evidence: true,
                    clipKey: true,
                    screenshotKey: true,
                },
            },
        },
    });
    if (report == null) return undefined;

    // The two-plane verdict stored as a string; anything other than `client_bug` is the app-health `passed` plane.
    const verdict: AppHealthVerdict = report.verdict === CLIENT_BUG ? CLIENT_BUG : ANALYSIS_VERDICT.passed;
    const coverage = coverageSummarySchema.safeParse(report.coverage);
    return {
        verdict,
        narration: report.narration ?? undefined,
        coverage: coverage.success ? coverage.data : undefined,
        clientBugs: report.findings.map(toClientBugFinding),
    };
}

function toClientBugFinding(finding: {
    findingKey: string;
    headline: string;
    whatHappened: string | null;
    remediation: string | null;
    evidence: Prisma.JsonValue;
    clipKey: string | null;
    screenshotKey: string | null;
}): AnalysisClientBugFinding {
    const parsed = evidenceListSchema.safeParse(finding.evidence);
    const evidence = parsed.success
        ? parsed.data.map((item) => ({
              source: item.source,
              detail: item.detail,
              file: item.file,
              lines: item.lines,
              snippet: item.snippet,
          }))
        : [];
    return {
        findingKey: finding.findingKey,
        headline: finding.headline,
        whatHappened: finding.whatHappened ?? undefined,
        remediation: finding.remediation ?? undefined,
        evidence,
        clipKey: finding.clipKey ?? undefined,
        screenshotKey: finding.screenshotKey ?? undefined,
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
 * Absolute base URL of the in-app analysis report for this snapshot; each client-bug card appends its
 * `findingKey`. The `analysis` route segment is the authoritative counterpart to the frozen `investigation`
 * report, kept distinct so the two never collide.
 */
function buildReportBaseUrl(appSlug: string, prNumber: number, snapshotId: string): string {
    const path = `/app/${encodeURIComponent(appSlug)}/pull-requests/${prNumber}/snapshots/${snapshotId}/analysis`;
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
