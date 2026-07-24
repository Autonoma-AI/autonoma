import { Skeleton } from "@autonoma/blacklight";
import type { AnalysisReportData } from "@autonoma/types";
import { AnalysisFindingsPanel } from "components/analysis/findings-panel";
import { PrVerdictHeadline } from "components/analysis/pr-verdict-headline";
import { AnalysisReportProse } from "components/analysis/report-prose";
import { SnapshotIssueChanges, SnapshotIssueChangesSkeleton } from "components/analysis/snapshot-issue-changes";
import { useAnalysisIssues } from "lib/query/branches.queries";
import { Suspense } from "react";

/**
 * The authoritative snapshot report body - the per-JOB view (one checkpoint's analysis run). The report prose as
 * of this job leads, then the run's two-plane verdict + its findings list, then the issue-set changes this job
 * made (issues opened / carried forward / resolved). The impact-analysis reasoning is admin-only and rendered by
 * the route.
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
      <PrVerdictHeadline findings={report.findings} />
      {report.reportMarkdown != null && (
        <Suspense fallback={<Skeleton className="h-48 w-full" />}>
          <SnapshotReportProse
            markdown={report.reportMarkdown}
            report={report}
            prNumber={prNumber}
            snapshotId={snapshotId}
          />
        </Suspense>
      )}
      <AnalysisFindingsPanel findings={report.findings} prNumber={prNumber} snapshotId={snapshotId} />
      <Suspense fallback={<SnapshotIssueChangesSkeleton />}>
        <SnapshotIssueChanges snapshotId={snapshotId} prNumber={prNumber} />
      </Suspense>
    </div>
  );
}

/**
 * The prose, split out so its branch-issues query suspends on its own. The prose is PR-CUMULATIVE even on a
 * per-job view, so it routinely references issues with no finding in this run - a carried-forward one, or one this
 * run resolved. Resolving `issue:` tokens against the whole branch's issue set (not this run's findings) is what
 * lets those link; only a genuinely fabricated id falls through to plain text.
 */
function SnapshotReportProse({
  markdown,
  report,
  prNumber,
  snapshotId,
}: {
  markdown: string;
  report: AnalysisReportData;
  prNumber: number;
  snapshotId: string;
}) {
  const { data: issues } = useAnalysisIssues(report.branchId);
  const issueIds = new Set(issues.map((issue) => issue.id));

  return (
    <AnalysisReportProse
      markdown={markdown}
      evidence={report.reportEvidence}
      prNumber={prNumber}
      snapshotId={snapshotId}
      findings={report.findings}
      issueIds={issueIds}
    />
  );
}
