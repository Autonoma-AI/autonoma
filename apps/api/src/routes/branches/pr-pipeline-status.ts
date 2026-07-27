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

interface LatestRunState {
    /**
     * Raw `branch_snapshot.status` of the branch's newest non-cancelled snapshot. `processing` means a run is in
     * flight; `failed` means the run died (only analysis settlement writes that status, so it is unambiguous - if
     * another writer is ever added, this reads it as an analysis failure).
     */
    status: string;
    /** The commit the run operated on. */
    headSha?: string;
}

interface PrPipelineStatusInput {
    /** The last *promoted* analysis for the branch, if any. `headSha` anchors staleness. */
    activeSnapshot?: { headSha?: string; summary?: CheckpointPresentationSummary };
    /**
     * The branch's newest non-cancelled snapshot, which may be neither active nor pending: a failed run sits on no
     * branch pointer at all. Reached by branchId, the same way the checkpoint rail reads it, so the pill and the
     * rail can never disagree about which run is newest.
     */
    latestRun?: LatestRunState;
    /** The branch's most-recent live preview environment (resolved by repo + PR), if any. */
    previewEnv?: PreviewEnvState;
}

/**
 * Rolls a branch's deploy/analyze pipeline into a single {@link PrPipelineStatus} for the PR list and
 * headers. Uses SHA-equality and the newest run's status only - never timestamps - so it works
 * identically for previewkit clients and clients whose deploy is external (no preview env, only the
 * snapshot signal). Precedence (first match wins):
 *
 * 1. The newest run is in flight -> `analyzing`.
 * 2. The newest run failed on the current commit -> `analysis_failed`.
 * 3. The preview sits on a commit no completed analysis has caught up to -> the live build state
 *    (`build_failed` / `building` / `pending_checks`). A failure on a commit a newer deploy has already
 *    replaced is stale and falls through to here rather than staying sticky.
 * 4. The completed analysis is current -> `checkpoint`.
 * 5. Otherwise `none`.
 */
export function computePrPipelineStatus({
    activeSnapshot,
    latestRun,
    previewEnv,
}: PrPipelineStatusInput): PrPipelineStatus {
    if (latestRun?.status === "processing") return { kind: "analyzing" };

    // A missing preview env (external, off-platform deploys) carries no deployed-commit signal, so the newest run
    // is the most current thing we know about - the same assumption `previewOnCurrentCommit` makes below.
    const previewSha = previewEnv?.headSha;
    const deployedShaUnknown = previewSha == null || previewSha === "";
    const failedRunIsCurrent =
        latestRun?.status === "failed" && (deployedShaUnknown || previewSha === latestRun.headSha);
    if (failedRunIsCurrent) return { kind: "analysis_failed" };

    const analyzedSha = activeSnapshot?.headSha;
    const previewOnCurrentCommit = deployedShaUnknown || previewSha === analyzedSha;
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
