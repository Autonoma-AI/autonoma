import { Badge } from "@autonoma/blacklight";
import { type AnalysisIssueSummary, type AnalysisVerdictState, deriveAnalysisVerdict } from "@autonoma/types";
import { RUN_VERDICT_COPY, VerdictHeadline } from "components/analysis/verdict-headline";

/**
 * The verdict headline for the PR as a whole, driven by the branch's OPEN issues rather than one run's findings - so it
 * reflects the cumulative state across every snapshot (a bug found two commits ago and still open keeps the PR red).
 * The per-run counterpart is `PrVerdictHeadline` on the snapshot page.
 *
 * The prose prefers the Reporter's authored summary - what actually happened on THIS PR - and falls back to the
 * generic policy sentence only for a run old enough to have no summary.
 */
export function AnalysisPrIssuesHeadline({
  issues,
  testCount,
  summary,
}: {
  issues: AnalysisIssueSummary[];
  /** Tests the run reached a verdict on. Zero means nothing was exercised. */
  testCount: number;
  /** The Reporter's one-paragraph account of the run. Absent on a run that predates it. */
  summary?: string;
}) {
  const bugCount = issues.filter((issue) => issue.kind === "bug").length;
  const otherCount = issues.length - bugCount;
  const state = deriveAnalysisVerdict({
    bugCount,
    coverageGapCount: otherCount,
    investigatedCount: testCount,
  });
  const copy = headlineCopy(state, bugCount);

  return (
    <VerdictHeadline
      state={state}
      badge={copy.badge}
      title={copy.title}
      pills={
        otherCount > 0 && (
          <Badge variant="outline" className="font-mono text-3xs">
            {otherCount} environment/scenario {otherCount === 1 ? "issue" : "issues"}
          </Badge>
        )
      }
    >
      {summary ?? copy.prose}
      {otherCount > 0 &&
        ` ${otherCount} environment/scenario ${otherCount === 1 ? "issue" : "issues"} could not confirm app health and don't block the PR.`}
    </VerdictHeadline>
  );
}

interface HeadlineCopy {
  badge: string;
  title: string;
  prose: string;
}

/** The PR's wording: the badge counts the branch's OPEN issues, which outlive any single run. */
function headlineCopy(state: AnalysisVerdictState, bugCount: number): HeadlineCopy {
  switch (state) {
    case "bug_found":
      return {
        badge: `${bugCount} open ${bugCount === 1 ? "bug" : "bugs"}`,
        title: "This PR has open bugs to fix",
        prose: "Only bug issues count against this PR - review each one below.",
      };
    case "not_confirmed":
      return {
        badge: RUN_VERDICT_COPY.not_confirmed.badge,
        title: RUN_VERDICT_COPY.not_confirmed.title,
        prose: "Environment/scenario issues couldn't confirm app health; they don't block the PR.",
      };
    case "no_tests_needed":
      return RUN_VERDICT_COPY.no_tests_needed;
    case "healthy":
      return {
        badge: "No open bugs",
        title: "No open bugs on this PR",
        prose: "Everything the agent checked passed or was non-blocking.",
      };
  }
}
