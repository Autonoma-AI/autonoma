import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import type { AnalysisJobStatus } from "lib/query/branches.queries";

/** The empty states the analysis stages share, so their copy and framing stay identical across the surfaces. */

/** A snapshot whose run never existed (a diffs snapshot, or one the pipeline did not analyze). */
export function NotAnalyzedNote() {
  return <p className="text-sm text-text-secondary">This checkpoint was not analyzed.</p>;
}

/**
 * The selection-stage empty state, shown by both the impact stage and the running list when the run has no
 * findings. Two distinct states hide behind "no findings": impact analysis is still selecting (the run is
 * mid-analysis and has not recorded its choice yet), or it concluded and chose nothing. Only the settled case
 * asserts "selected none" - claiming it while selection is still in flight would be premature.
 */
export function EmptySelectionNote({ pending }: { pending?: boolean }) {
  if (pending) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-border-dim bg-surface-void px-5 py-6 text-sm text-text-secondary">
        <CircleNotchIcon size={14} className="animate-spin" />
        Impact analysis is selecting the tests this diff puts at risk.
      </p>
    );
  }
  return (
    <p className="rounded-lg border border-border-dim bg-surface-void px-5 py-6 text-sm text-text-secondary">
      This diff needed no tests - impact analysis selected none.
    </p>
  );
}

/**
 * Whether impact analysis is still choosing which tests to run. Findings are born at selection and the reasoning
 * is written in the same step, so a running job with no reasoning yet has not selected - its empty run view is
 * "not yet", not "nothing". Any terminal job, or a running one that has recorded its reasoning, has settled.
 */
export function isSelectionPending(
  job: { status: AnalysisJobStatus; impactReasoning?: string } | null | undefined,
): boolean {
  if (job == null) return false;
  if (job.status !== "running") return false;
  return job.impactReasoning == null || job.impactReasoning.trim() === "";
}

/**
 * Whether impact analysis has finished choosing - the inverse of {@link isSelectionPending}, but false for a
 * missing job (a diffs snapshot has settled nothing). Drives the impact stage's indicator: a run that selected
 * zero tests has still concluded, so impact reads complete, never a spinner.
 */
export function isSelectionSettled(
  job: { status: AnalysisJobStatus; impactReasoning?: string } | null | undefined,
): boolean {
  return job != null && !isSelectionPending(job);
}
