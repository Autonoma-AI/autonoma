/**
 * The PostHog group key the merge-gate events are attributed to.
 */
export const MERGE_GATE_ANALYTICS_GROUP = "organization";

/** Merge-gate PostHog event names. */
export const MERGE_GATE_EVENT = {
    /** A check conclusion was posted for a PR head. Emitted by the worker at finalize. */
    checkPosted: "merge_gate.check_posted",
    /** A developer clicked Skip ). Emitted by the API on requested_action. */
    skipped: "merge_gate.skipped",
    /** A PR merged around a blocking check with no skip. Emitted by the API on close. */
    bypassed: "merge_gate.bypassed",
} as const;
