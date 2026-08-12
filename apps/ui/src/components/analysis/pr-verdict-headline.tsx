import { Badge } from "@autonoma/blacklight";
import type { AnalysisVerdictState, RunPlaneSummary } from "@autonoma/types";
import { RUN_VERDICT_COPY, VerdictHeadline } from "components/analysis/verdict-headline";

/**
 * The verdict headline for ONE analysis run, above that snapshot's findings list: what this commit's tests found.
 * The PR-level headline (`AnalysisPrIssuesHeadline`) speaks about the branch's cumulative issues instead.
 */
export function PrVerdictHeadline({ run }: { run: RunPlaneSummary }) {
  const { bugCount, passedCount } = run;
  const coverageCount = run.coverage.total;
  const state = run.state;
  const copy = headlineCopy(state, bugCount, coverageCount);

  return (
    <VerdictHeadline
      state={state}
      badge={copy.badge}
      title={copy.title}
      pills={
        <>
          {passedCount > 0 && (
            <Badge variant="status-passed" className="font-mono text-3xs">
              {passedCount} passed
            </Badge>
          )}
          {coverageCount > 0 && (
            <Badge variant="outline" className="font-mono text-3xs">
              {coverageCount} couldn&apos;t confirm
            </Badge>
          )}
        </>
      }
    >
      {copy.prose}
    </VerdictHeadline>
  );
}

interface HeadlineCopy {
  badge: string;
  title: string;
  prose: string;
}

/** This run's wording: the badge counts the findings this snapshot produced, not the PR's open issues. */
function headlineCopy(state: AnalysisVerdictState, bugCount: number, coverageCount: number): HeadlineCopy {
  switch (state) {
    case "bug_found":
      return {
        badge: `${bugCount} client ${bugCount === 1 ? "bug" : "bugs"}`,
        title: "This PR has app-level bugs to fix",
        prose: "Only client bugs count against this PR - review each one below.",
      };
    case "not_confirmed":
      return {
        badge: RUN_VERDICT_COPY.not_confirmed.badge,
        title: RUN_VERDICT_COPY.not_confirmed.title,
        prose: `Autonoma ran, but ${coverageCount} ${coverageCount === 1 ? "check" : "checks"} couldn't confirm app health this run, so the change isn't fully verified. These don't block the PR.`,
      };
    case "no_tests_needed":
      return RUN_VERDICT_COPY.no_tests_needed;
    case "healthy":
      return {
        badge: "No client bugs",
        title: "The app held up on the paths we tested",
        prose: "Everything the agent checked passed.",
      };
  }
}
