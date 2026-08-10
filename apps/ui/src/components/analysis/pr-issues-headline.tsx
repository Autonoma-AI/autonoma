import {
  type AnalysisFlow,
  type AnalysisIssueSummary,
  analysisFlowPillLabel,
  analysisPrTitle,
  derivePrVerdict,
  tallyAnalysisFlows,
} from "@autonoma/types";
import { VerdictHeadline } from "components/analysis/verdict-headline";

/**
 * How the PR reads, as a whole - the Reporter's own words over the branch's cumulative state.
 *
 * Both strings are authored, because a PR that verified six flows of seven has no honest two-word verdict; what a
 * reader needs is which parts are covered and which are not. The badge stays derived (from the flow tally and the
 * branch's open bugs), so the colour and the ratio can never be talked into disagreeing with the evidence.
 *
 * Issues are branch-scoped and outlive any one run, so a bug found two commits ago and still open keeps the PR red.
 */
export function AnalysisPrIssuesHeadline({
  issues,
  title,
  headline,
  flows,
  testCount,
  coverageGapCount,
}: {
  issues: AnalysisIssueSummary[];
  /** The Reporter's title. Empty on a report written before the Reporter authored one. */
  title: string;
  /** The Reporter's headline - always present, since a report exists only once one was authored. */
  headline: string;
  flows: AnalysisFlow[];
  /** The run's investigated-test count - the pre-flows reading, for a report written before the itemization. */
  testCount: number;
  /** The run's coverage-plane finding count - the other half of that fallback. */
  coverageGapCount: number;
}) {
  const bugCount = issues.filter((issue) => issue.kind === "bug").length;
  const tally = tallyAnalysisFlows(flows);
  const state = derivePrVerdict({ flows, openBugCount: bugCount, investigatedCount: testCount, coverageGapCount });

  return (
    <VerdictHeadline
      state={state}
      badge={analysisFlowPillLabel(state, tally, bugCount)}
      title={analysisPrTitle(title, state, bugCount)}
    >
      {headline}
    </VerdictHeadline>
  );
}
