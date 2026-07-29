/** Bug-fix-outcome PostHog event names (the stickiness "did it help?" measurement). */
export const BUG_FIX_OUTCOME_EVENT = {
    /** A flagged client bug was fixed before the PR merged (its AnalysisIssue was resolved by the last run). */
    fixed: "bug.fixed",
    /** A flagged client bug was still open when the PR merged. Distinct from `merge_gate.bypassed`, which is per-PR, this is per-bug. */
    mergedOpen: "bug.merged_open",
} as const;
