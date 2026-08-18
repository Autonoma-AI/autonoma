import type { AnalysisRunView } from "@autonoma/types";
import { AnalysisOriginBadge } from "components/analysis/analysis-origin-badge";
import { EmptySelectionNote } from "components/analysis/stage-empty-states";
import { ReasoningMarkdown } from "components/snapshot/reasoning-block";

/**
 * The "Impact analysis" stage: the reasoning narrative, the selection summary, and the selected tests with their
 * per-test selection reason. While selection is still `pending`, the count line is suppressed - a `0 targets`
 * reading before the choice is made would be a lie.
 */
export function AnalysisImpactStage({
  run,
  reasoning,
  selectionPending,
}: {
  run: AnalysisRunView;
  reasoning?: string;
  selectionPending?: boolean;
}) {
  const { targetCount, affectedCount, proposedCount } = run.selection;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">Reasoning</h3>
        {reasoning != null && reasoning.trim().length > 0 ? (
          <ReasoningMarkdown content={reasoning} />
        ) : (
          <p className="text-xs text-text-secondary">Impact analysis has not produced a selection summary yet.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">Selection</h3>
        {!selectionPending && (
          <p className="font-mono text-2xs text-text-secondary">
            {targetCount} {targetCount === 1 ? "target" : "targets"} · {affectedCount} affected · {proposedCount}{" "}
            proposed
          </p>
        )}
        {run.findings.length === 0 ? (
          <EmptySelectionNote pending={selectionPending} />
        ) : (
          <ul className="flex flex-col gap-2">
            {run.findings.map((finding) => (
              <li
                key={finding.findingId}
                className="flex items-start gap-4 rounded-lg border border-border-dim bg-surface-void px-4 py-3"
              >
                <AnalysisOriginBadge origin={finding.origin} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text-primary">{finding.testCase.name}</p>
                  {finding.selectionReason != null && (
                    <p className="mt-0.5 text-2xs text-text-secondary">{finding.selectionReason}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
