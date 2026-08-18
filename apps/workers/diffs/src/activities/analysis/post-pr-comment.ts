import {
    type GitHubPrCommentKind,
    OnboardingPreviewEnvironmentMode,
    type PrismaClient,
    PreviewkitStatus,
} from "@autonoma/db";
import {
    type AutonomaCommentCta,
    type AutonomaCommentPayload,
    type AutonomaCommentPreview,
    createGitHubPrCommentStore,
    hasGoneLive,
    postOrUpdateCommentOnGithub,
    resolveCommentAssetBaseUrl,
    SEE_PREVIEW_CTA_LABEL,
    toPrCommentTitle,
} from "@autonoma/github/comment";
import { imageFormatFromKey } from "@autonoma/image";
import { logger as rootLogger } from "@autonoma/logger";
import type { S3Storage } from "@autonoma/storage";
import { type AnalysisRunOutcome, buildPreviewFrontDoorUrl } from "@autonoma/types";
import { resolveRunTarget } from "../../codebase/run-target";
import type { GitHubAccess, SnapshotMeta } from "../../codebase/snapshot-context";
import { env } from "../../env";
import { buildAnalysisCommentPayload } from "./analysis-comment-payload";
import { loadAnalysisCommentInput } from "./load-analysis-comment-input";
import { isMergeGateEnabledForOrg } from "./merge-gate-enabled";

/** Screenshots are signed for the comment's lifetime; re-runs re-sign, so a week is plenty. */
const SCREENSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_SCREENSHOT_CONTENT_TYPE = "image/png";

/** Section 1 copy, one line per preview build state. */
const PREVIEW_READY = "Preview environment ready";
const PREVIEW_BUILDING = "Building the preview environment";
const PREVIEW_PREPARING = "Preparing the preview environment";
const PREVIEW_FAILED = "The preview environment failed to build";
const PREVIEW_NOT_NEEDED = "No preview environment was needed for this change";

/** Section 2 copy for the mid-flight and failed states; the settled body reuses the analysis payload. */
const ANALYZING_TITLE = "analyzing this PR";
const ANALYZING_HEADLINE = "Autonoma is analyzing this PR for client bugs.";
const BUILDING_TITLE = "building preview";
const BUILDING_HEADLINE = "Autonoma is building the preview environment; analysis starts once it is ready.";
const FAILED_TITLE = "couldn't analyze this PR";
const FAILED_HEADLINE = "Autonoma couldn't complete its analysis of this PR.";
const PREVIEW_FAILED_TITLE = "the preview build failed";
const PREVIEW_FAILED_HEADLINE = "Autonoma couldn't analyze this PR - the preview environment didn't come up.";

/** The per-kind comments this one supersedes; deleted on the unified comment's first post so no PR shows duplicates. */
const LEGACY_COMMENT_KINDS: readonly GitHubPrCommentKind[] = ["preview", "analysis"];

/** The coarse preview build state section 1 renders, read from the previewkit environment row for the head. */
type PreviewBuildState = "ready" | "building" | "failed" | "missing";

/** Section 1's rendered status plus the coarse build state that drives the mid-flight/failed section-2 copy. */
interface PreviewSection {
    preview: AutonomaCommentPreview;
    buildState: PreviewBuildState;
    /** The "See preview" button when the preview is browsable - used by the mid-flight comment, which has no other CTAs. */
    previewCta?: AutonomaCommentCta;
}

type PostResult = { status: "posted" | "updated" | "skipped"; commentId?: string };

/** The PR the comment lands on, plus the URLs its links and image assets are built from. */
interface PrCommentContext {
    prNumber: number;
    repoFullName: string;
    appBaseUrl: string;
    assetBaseUrl: string;
}

/**
 * Post (or update) the single Autonoma PR comment for a run still in flight - "Autonoma is analyzing this PR", with
 * the preview status section on top for a previewkit org. Called by the workflow at the start of the run (first
 * post) and again once the preview is ready. Owns exactly one comment per PR via the shared `pr` DB store; the first
 * post reposts at the bottom and deletes the legacy preview/analysis comments a mid-flight PR may still carry.
 *
 * `ANALYSIS_PR_COMMENT_ENABLED` is a kill switch, on by default.
 */
export async function postAnalyzingPrComment({
    db,
    github,
    meta,
    firstPost,
}: {
    db: PrismaClient;
    github: GitHubAccess;
    meta: SnapshotMeta;
    /** True for the run's first comment write - reposts at the bottom and cleans up the legacy comments. */
    firstPost: boolean;
}): Promise<PostResult> {
    const logger = rootLogger.child({ name: "postAnalyzingPrComment", snapshotId: meta.snapshotId });
    logger.info("Posting analyzing PR comment", { extra: { firstPost } });

    if (!env.ANALYSIS_PR_COMMENT_ENABLED) return skip(logger, "ANALYSIS_PR_COMMENT_ENABLED is off");
    if (!hasGoneLive(meta.onboardingStep)) return skip(logger, "application is not fully onboarded");

    const ctx = await resolvePrCommentContext(github, meta);
    if (ctx == null) return skip(logger, "run has no pull request to comment on");

    const section = await loadPreviewSection(db, meta, ctx, "in_flight");
    const payload = buildAnalyzingPayload(ctx.prNumber, section);
    return await upsertPrComment(db, github, ctx, meta, payload, firstPost, logger);
}

/**
 * Post (or update) the single Autonoma PR comment for a SETTLED run. On success it renders the full analysis body
 * (issues, cards, report prose, handoff) with the preview status on top; on failure it states that the run could not
 * be completed. A superseded run writes nothing - a newer run owns the comment. Writes the same one comment per PR as
 * {@link postAnalyzingPrComment}, updating it in place.
 */
export async function postSettledPrComment({
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
}): Promise<PostResult> {
    const logger = rootLogger.child({ name: "postSettledPrComment", snapshotId: meta.snapshotId });
    logger.info("Posting settled PR comment", { extra: { outcome: outcome.kind } });

    if (!env.ANALYSIS_PR_COMMENT_ENABLED) return skip(logger, "ANALYSIS_PR_COMMENT_ENABLED is off");
    // A newer run supersedes this one and owns the comment; touching it would clobber the newer head's state.
    if (outcome.kind === "superseded") return skip(logger, "run was superseded");
    if (!hasGoneLive(meta.onboardingStep)) return skip(logger, "application is not fully onboarded");

    const ctx = await resolvePrCommentContext(github, meta);
    if (ctx == null) return skip(logger, "run has no pull request to comment on");

    if (outcome.kind === "failed") {
        const section = await loadPreviewSection(db, meta, ctx, "settled");
        return await upsertPrComment(db, github, ctx, meta, buildFailedPayload(ctx.prNumber, section), false, logger);
    }

    const [report, previewUrl] = await Promise.all([
        loadAnalysisCommentInput(meta.snapshotId),
        resolvePreviewUrl(db, meta.snapshotId),
    ]);
    if (report == null) return skip(logger, "no AnalysisReport persisted for this snapshot");

    const mergeGateBlocking =
        report.verdict.state === "bug_found" && (await isMergeGateEnabledForOrg(meta.organizationId));

    const base = await buildAnalysisCommentPayload(
        { ...report, mergeGateBlocking },
        {
            prNumber: ctx.prNumber,
            repoFullName: ctx.repoFullName,
            commitSha: meta.headSha,
            appSlug: meta.appSlug,
            previewUrl,
            appBaseUrl: ctx.appBaseUrl,
            assetBaseUrl: ctx.assetBaseUrl,
        },
        makeScreenshotSigner(storage, meta.snapshotId),
    );

    const section = await loadPreviewSection(db, meta, ctx, "settled", previewUrl);
    const payload = assembleSettledPrPayload(base, section);
    return await upsertPrComment(db, github, ctx, meta, payload, false, logger);
}

function skip(logger: ReturnType<typeof rootLogger.child>, reason: string): PostResult {
    logger.info("Skipping PR comment", { extra: { reason } });
    return { status: "skipped" };
}

async function resolvePrCommentContext(
    github: GitHubAccess,
    meta: SnapshotMeta,
): Promise<PrCommentContext | undefined> {
    const target = await resolveRunTarget({
        branchId: meta.branchId,
        githubRepositoryId: meta.githubRepositoryId,
        githubClient: github.githubClient,
    });
    if (target.kind !== "pull_request") return undefined;
    const appBaseUrl = resolveAppUrl();
    return {
        prNumber: target.prNumber,
        repoFullName: github.repoFullName,
        appBaseUrl,
        assetBaseUrl: resolveCommentAssetBaseUrl({ appUrl: appBaseUrl }),
    };
}

/**
 * Upsert the unified comment through the shared `pr` store. The first post of a run reposts a fresh comment at the
 * bottom of the PR (and first clears the legacy comments); every later write in the same run edits it in place. The
 * newest run always owns the comment (`allow-new-head`).
 */
async function upsertPrComment(
    db: PrismaClient,
    github: GitHubAccess,
    ctx: PrCommentContext,
    meta: SnapshotMeta,
    payload: AutonomaCommentPayload,
    firstPost: boolean,
    logger: ReturnType<typeof rootLogger.child>,
): Promise<PostResult> {
    if (firstPost) await deleteLegacyComments(db, github, ctx, logger);

    const result = await postOrUpdateCommentOnGithub({
        client: github.githubClient,
        store: createGitHubPrCommentStore(db, "pr"),
        repoFullName: ctx.repoFullName,
        prNumber: ctx.prNumber,
        lastCommitSha: meta.headSha,
        payload,
        staleGuard: "allow-new-head",
        mode: firstPost ? "repost" : "update",
    });

    if (result.status === "stale_skipped") {
        logger.info("PR comment skipped - a newer run owns the comment", {
            extra: { storedHeadSha: result.storedHeadSha, incomingHeadSha: result.incomingHeadSha },
        });
        return { status: "skipped" };
    }
    logger.info("PR comment written", { extra: { status: result.status, commentId: result.commentId } });
    return { status: result.status, commentId: result.commentId };
}

/** Delete the legacy preview/analysis comments this one replaces, so a PR mid-flight at deploy shows only the new one. */
async function deleteLegacyComments(
    db: PrismaClient,
    github: GitHubAccess,
    ctx: PrCommentContext,
    logger: ReturnType<typeof rootLogger.child>,
): Promise<void> {
    for (const kind of LEGACY_COMMENT_KINDS) {
        const stored = await createGitHubPrCommentStore(db, kind).getState(ctx.repoFullName, ctx.prNumber);
        if (stored?.commentId == null) continue;
        try {
            await github.githubClient.deleteComment(ctx.repoFullName, stored.commentId);
            logger.info("Deleted legacy PR comment", { extra: { kind, commentId: stored.commentId } });
        } catch (err) {
            logger.warn("Failed to delete legacy PR comment", { extra: { kind, commentId: stored.commentId, err } });
        }
    }
}

/** Section 1: the preview environment status, for a previewkit org only. Absent when the customer hosts the preview. */
async function loadPreviewSection(
    db: PrismaClient,
    meta: SnapshotMeta,
    ctx: PrCommentContext,
    phase: "in_flight" | "settled",
    knownPreviewUrl?: string,
): Promise<PreviewSection | undefined> {
    const application = await db.application.findUnique({
        where: { id: meta.applicationId },
        select: { onboardingState: { select: { previewEnvironmentMode: true } } },
    });
    // Only a previewkit-hosted app has a section 1; a BYO-preview app and an unset one both mean the customer hosts
    // the preview (the same cut `autonomaHostsPreviews` in @autonoma/scenario makes).
    if (application?.onboardingState?.previewEnvironmentMode !== OnboardingPreviewEnvironmentMode.previewkit) {
        return undefined;
    }

    const [buildState, resolvedUrl] = await Promise.all([
        loadPreviewBuildState(db, ctx.repoFullName, ctx.prNumber, meta.headSha),
        knownPreviewUrl != null ? Promise.resolve(knownPreviewUrl) : resolvePreviewUrl(db, meta.snapshotId),
    ]);
    const previewCta =
        resolvedUrl != null && resolvedUrl !== ""
            ? { label: SEE_PREVIEW_CTA_LABEL, href: buildPreviewFrontDoorUrl(ctx.appBaseUrl, resolvedUrl) }
            : undefined;

    return { preview: describePreview(buildState, phase), buildState, previewCta };
}

/**
 * Section 1's status line for a coarse build state - a pure status banner, no link (the "See preview" button rides at
 * the bottom of the comment for both org types). `missing` reads as "preparing" mid-flight and "not needed" at settle.
 */
export function describePreview(buildState: PreviewBuildState, phase: "in_flight" | "settled"): AutonomaCommentPreview {
    if (buildState === "ready") return { state: "healthy", status: PREVIEW_READY };
    if (buildState === "building") return { state: "running", status: PREVIEW_BUILDING };
    if (buildState === "failed") return { state: "critical", status: PREVIEW_FAILED };
    if (phase === "settled") return { state: "incomplete", status: PREVIEW_NOT_NEEDED };
    return { state: "running", status: PREVIEW_PREPARING };
}

/** The previewkit build state for this head, from the environment row per (repo, PR). */
async function loadPreviewBuildState(
    db: PrismaClient,
    repoFullName: string,
    prNumber: number,
    headSha: string,
): Promise<PreviewBuildState> {
    const environment = await db.previewkitEnvironment.findUnique({
        where: { repoFullName_prNumber: { repoFullName, prNumber } },
        select: { headSha: true, status: true },
    });
    if (environment == null || environment.headSha !== headSha) return "missing";
    switch (environment.status) {
        case PreviewkitStatus.ready:
            return "ready";
        // A PR closed mid-build tears the environment down: no preview is coming for this head.
        case PreviewkitStatus.failed:
        case PreviewkitStatus.torn_down:
            return "failed";
        case PreviewkitStatus.pending:
        case PreviewkitStatus.building:
        case PreviewkitStatus.deploying:
        case PreviewkitStatus.superseded:
            return "building";
    }
}

export function buildAnalyzingPayload(prNumber: number, section: PreviewSection | undefined): AutonomaCommentPayload {
    const building = section?.buildState === "building";
    return {
        ...emptyPrPayload(prNumber),
        state: "running",
        title: toPrCommentTitle(building ? BUILDING_TITLE : ANALYZING_TITLE),
        headline: building ? BUILDING_HEADLINE : ANALYZING_HEADLINE,
        preview: section?.preview,
        // The only CTA mid-flight: the preview button, once the preview is browsable.
        ctas: section?.previewCta != null ? [section.previewCta] : [],
    };
}

export function buildFailedPayload(prNumber: number, section: PreviewSection | undefined): AutonomaCommentPayload {
    const previewFailed = section?.buildState === "failed";
    return {
        ...emptyPrPayload(prNumber),
        state: "incomplete",
        title: toPrCommentTitle(previewFailed ? PREVIEW_FAILED_TITLE : FAILED_TITLE),
        headline: previewFailed ? PREVIEW_FAILED_HEADLINE : FAILED_HEADLINE,
        preview: section?.preview,
    };
}

/**
 * The settled comment: the analysis body with the `pr` kind, the dash-form title, and section 1 on top. The base
 * already carries the "See preview" button whenever a preview URL exists (previewkit or BYO), so the button placement
 * is uniform and section 1 stays a pure status banner - no CTA rewriting here.
 */
export function assembleSettledPrPayload(
    base: AutonomaCommentPayload,
    section: PreviewSection | undefined,
): AutonomaCommentPayload {
    return {
        ...base,
        kind: "pr",
        title: toPrCommentTitle(base.title ?? ""),
        preview: section?.preview,
    };
}

/** A `pr`-kind payload with no findings - the base for the mid-flight and failed states. */
function emptyPrPayload(prNumber: number): AutonomaCommentPayload {
    return {
        state: "running",
        kind: "pr",
        prNumber,
        headline: "",
        ctas: [],
        services: [],
        bugs: [],
        notes: [],
        flowGroups: [],
        warnings: [],
        details: [],
        previewUrls: [],
    };
}

/**
 * The media signer the payload builder is handed: turns an `s3://` key into a short-lived signed URL, tagged so
 * GitHub's image proxy renders it right. A signing failure is contained (logged + undefined) so a broken screenshot
 * never sinks the comment.
 */
function makeScreenshotSigner(storage: S3Storage, snapshotId: string): (s3Key: string) => Promise<string | undefined> {
    const logger = rootLogger.child({ name: "makeScreenshotSigner", snapshotId });
    return async (s3Key) => {
        const contentType = imageFormatFromKey(s3Key)?.mediaType ?? DEFAULT_SCREENSHOT_CONTENT_TYPE;
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
