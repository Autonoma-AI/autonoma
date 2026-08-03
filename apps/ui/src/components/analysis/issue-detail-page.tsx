import { IssueBackLink } from "components/analysis/issue-back-link";
import { AnalysisIssueDetail, AnalysisIssueDetailSkeleton } from "components/analysis/issue-detail";
import { useAnalysisIssueDetail } from "lib/query/branches.queries";

/**
 * The issue-detail body, shared by the two routes that host it: the PR-scoped one, which passes the PR number so
 * the issue's finding instances link to their per-snapshot pages, and the branch-agnostic one that main's problems
 * link to. Absence resolves to a calm not-found - an unknown or malformed issue id is a legitimate read outcome.
 */
export function AnalysisIssueDetailPage({ issueId, prNumber }: { issueId: string; prNumber?: number }) {
  const { data: issue, isPending } = useAnalysisIssueDetail(issueId);

  if (isPending) return <AnalysisIssueDetailSkeleton />;

  if (issue == null) {
    return (
      <div className="flex flex-col gap-4">
        <IssueBackLink prNumber={prNumber} />
        <p className="rounded-lg border border-border-dim bg-surface-base px-5 py-6 text-sm text-text-secondary">
          This issue could not be found.
        </p>
      </div>
    );
  }

  return <AnalysisIssueDetail issue={issue} prNumber={prNumber} />;
}
