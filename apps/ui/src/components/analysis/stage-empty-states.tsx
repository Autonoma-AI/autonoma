/** The empty states the analysis stages share, so their copy and framing stay identical across the surfaces. */

/** A snapshot whose run never existed (a diffs snapshot, or one the pipeline did not analyze). */
export function NotAnalyzedNote() {
  return <p className="text-sm text-text-secondary">This checkpoint was not analyzed.</p>;
}

/** A run that analyzed the diff and selected no tests - shown by both the impact stage and the running list. */
export function EmptySelectionNote() {
  return (
    <p className="rounded-lg border border-border-dim bg-surface-void px-5 py-6 text-sm text-text-secondary">
      This diff needed no tests - impact analysis selected none.
    </p>
  );
}
