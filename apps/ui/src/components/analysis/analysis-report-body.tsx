import type { AnalysisReportData } from "@autonoma/types";
import { AnalysisFindingsPanel } from "components/analysis/findings-panel";
import { ReasoningPanel } from "components/snapshot/reasoning-panel";

/**
 * The authoritative snapshot report body (rendered when the snapshot has an `AnalysisReport`): the findings list
 * in the TESTS RUN slot, then IMPACT ANALYSIS (the selection reasoning) alongside FINDINGS SUMMARY (the two-plane
 * verdict narration). SUITE CHANGES THIS SNAPSHOT and BUGS FOUND are gone - every finding, client bug included,
 * lives in the findings list and opens its own evidence detail.
 */
export function AnalysisReportBody({
  report,
  prNumber,
  snapshotId,
}: {
  report: AnalysisReportData;
  prNumber: number;
  snapshotId: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <AnalysisFindingsPanel findings={report.findings} prNumber={prNumber} snapshotId={snapshotId} />
      <div className="grid gap-6 lg:grid-cols-2">
        <ReasoningPanel
          title="Impact analysis"
          content={report.impactReasoning}
          empty="Analysis has not produced a summary yet."
        />
        <ReasoningPanel
          title="Findings summary"
          content={report.narration}
          empty="No summary was recorded for this checkpoint."
        />
      </div>
    </div>
  );
}
