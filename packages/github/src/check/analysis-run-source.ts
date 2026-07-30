/**
 * How an analysis run was requested under activation. Nothing runs on its own: a run starts because someone
 * asked. `comment` is a `/start analysis` PR comment.
 */
export const ANALYSIS_RUN_SOURCE = {
    comment: "comment",
} as const;

export type AnalysisRunSource = (typeof ANALYSIS_RUN_SOURCE)[keyof typeof ANALYSIS_RUN_SOURCE];
