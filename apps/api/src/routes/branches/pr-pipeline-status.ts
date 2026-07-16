import type { CheckpointPresentationSummary, PrPipelineStatus } from "@autonoma/types";

// Raw `previewkit_environment.status` values that mean the preview is still coming up (not yet
// serving). Torn-down environments are filtered out before this runs, so they never reach here.
const IN_FLIGHT_ENV_STATUSES: ReadonlySet<string> = new Set(["pending", "building", "deploying"]);

interface PreviewEnvState {
    /** Raw `previewkit_environment.status`: pending | building | deploying | ready | failed. */
    status: string;
    /** The commit the environment is building/serving. */
    headSha: string;
}

interface PrPipelineStatusInput {
    /** The last *completed* analysis for the branch, if any. `headSha` anchors staleness. */
    activeSnapshot?: { headSha?: string; summary?: CheckpointPresentationSummary };
    /** True when an analysis is in flight (a processing pending snapshot exists). */
    hasPendingAnalysis: boolean;
    /** The branch's most-recent live preview environment (resolved by repo + PR), if any. */
    previewEnv?: PreviewEnvState;
}

/**
 * Rolls a branch's deploy/analyze pipeline into a single {@link PrPipelineStatus} for the PR list and
 * headers. Uses SHA-equality and the in-flight snapshot pointer only - never timestamps - so it works
 * identically for previewkit clients and clients whose deploy is external (no preview env, only the
 * pending-snapshot signal). Precedence (first match wins):
 *
 * 1. An analysis is running -> `analyzing`.
 * 2. The preview sits on a commit the completed analysis has not caught up to -> the live build state
 *    (`build_failed` / `building` / `pending_checks`).
 * 3. The completed analysis is current -> `checkpoint`.
 * 4. Otherwise `none` (or the preview's build state for a preview-only PR with no analysis yet).
 */
export function computePrPipelineStatus({
    activeSnapshot,
    hasPendingAnalysis,
    previewEnv,
}: PrPipelineStatusInput): PrPipelineStatus {
    if (hasPendingAnalysis) return { kind: "analyzing" };

    const analyzedSha = activeSnapshot?.headSha;
    const previewOnCurrentCommit =
        previewEnv == null || previewEnv.headSha === "" || previewEnv.headSha === analyzedSha;
    const analysisIsCurrent = activeSnapshot != null && previewOnCurrentCommit;

    if (analysisIsCurrent) {
        return activeSnapshot.summary != null
            ? { kind: "checkpoint", summary: activeSnapshot.summary }
            : { kind: "none" };
    }

    // Analysis is missing or stale for the deployed commit: describe where the preview is instead.
    if (previewEnv != null) {
        if (previewEnv.status === "failed") return { kind: "build_failed" };
        if (IN_FLIGHT_ENV_STATUSES.has(previewEnv.status)) return { kind: "building" };
        return { kind: "pending_checks" };
    }

    return { kind: "none" };
}
