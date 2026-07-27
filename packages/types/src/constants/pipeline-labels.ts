/**
 * The labels every surface uses for a branch's pipeline states, so the PR list pill, the PR/main header badge,
 * the checkpoint rail and the metrics line can never drift into describing the same state differently.
 *
 * `checkpointFailed` and `analysisFailed` are the same underlying state - the analysis run died - worded for two
 * different surfaces: the rail has room for a "pipeline error" sub-line, the compact pill does not.
 */
export const PIPELINE_LABEL = {
    analyzing: "Analyzing",
    analysisFailed: "Analysis failed",
    checkpointFailed: "Checkpoint failed",
} as const;
