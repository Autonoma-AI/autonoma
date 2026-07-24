import { Badge, StatusDot } from "@autonoma/blacklight";
import type { AnalysisIssueSummary } from "@autonoma/types";

/**
 * The PR verdict headline in the issues-first model: the app-health signal is the count of OPEN bug issues (the
 * only class that counts against the PR); environment/scenario issues are a quiet, non-blocking sub-count. Driven
 * by the branch's open-issues list, so the headline reflects the cumulative PR state, not just one snapshot.
 *
 * The subtitle prefers the Reporter's authored summary of the run - what actually happened on THIS PR - and falls
 * back to the generic policy sentence only for a run old enough to have no summary.
 */
export function AnalysisPrIssuesHeadline({
  issues,
  summary,
}: {
  issues: AnalysisIssueSummary[];
  /** The Reporter's one-paragraph account of the run. Absent on a run that predates it. */
  summary?: string;
}) {
  const bugCount = issues.filter((issue) => issue.kind === "bug").length;
  const otherCount = issues.length - bugCount;
  const hasBugs = bugCount > 0;
  const fallback = hasBugs
    ? "Only bug issues count against this PR - review each one below."
    : "Everything the agent checked passed or was non-blocking.";

  return (
    <div className="flex flex-col gap-3 border border-border-dim bg-surface-base px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={hasBugs ? "critical" : "success"} className="gap-1 font-mono uppercase tracking-wider">
          <StatusDot status={hasBugs ? "critical" : "success"} />
          {hasBugs ? `${bugCount} open ${bugCount === 1 ? "bug" : "bugs"}` : "No open bugs"}
        </Badge>
        {otherCount > 0 && (
          <Badge variant="outline" className="font-mono text-3xs">
            {otherCount} environment/scenario {otherCount === 1 ? "issue" : "issues"}
          </Badge>
        )}
      </div>

      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-text-primary">
          {hasBugs ? "This PR has open bugs to fix" : "No open bugs on this PR"}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          {summary ?? fallback}
          {otherCount > 0 &&
            ` ${otherCount} environment/scenario ${otherCount === 1 ? "issue" : "issues"} could not confirm app health and don't block the PR.`}
        </p>
      </div>
    </div>
  );
}
