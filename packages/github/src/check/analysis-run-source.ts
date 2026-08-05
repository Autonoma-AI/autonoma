/**
 * How an analysis run was requested under activation. Nothing runs on its own: a run starts because someone
 * asked. `comment` is a `/start analysis` PR comment; `mcp` is the `start_analysis` debug-MCP tool a coding
 * agent calls from the editor when it is done fixing; `label` is the repo's configured analysis-trigger label
 * being added to the PR; `ready_for_review` is the auto-run-on-ready trigger (a repo opting into
 * `autoRunOnReadyForReview`): that run fires from the shared PR-diffs trigger on preview-ready rather than
 * through `requestAnalysisRun`, and the worker's `openMergeGate` step stamps this source when it flips the check;
 * `ui` is the "run from Autonoma" button in the dashboard.
 */
export const ANALYSIS_RUN_SOURCE = {
    comment: "comment",
    mcp: "mcp",
    label: "label",
    ready_for_review: "ready_for_review",
    ui: "ui",
} as const;

export type AnalysisRunSource = (typeof ANALYSIS_RUN_SOURCE)[keyof typeof ANALYSIS_RUN_SOURCE];
