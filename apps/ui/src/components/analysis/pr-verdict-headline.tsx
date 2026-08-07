import { Badge } from "@autonoma/blacklight";
import { type AnalysisVerdictState, type InvestigationFinding, deriveAnalysisVerdict } from "@autonoma/types";
import { RUN_VERDICT_COPY, VerdictHeadline } from "components/analysis/verdict-headline";
import { analysisVerdictMeta } from "components/analysis/verdict-meta";

/**
 * The verdict headline for ONE analysis run, shown above that snapshot's findings list. Its counts come from the run's
 * own findings, so it speaks in the present tense about what this commit's tests found; the PR-level headline
 * (`AnalysisPrIssuesHeadline`) speaks about the branch's cumulative open issues instead.
 *
 * Every count is derived from the verdict SSOT (`analysisVerdictMeta` + `deriveAnalysisVerdict`), never hand-listed,
 * so the split can never drift from the taxonomy.
 */
export function PrVerdictHeadline({
  findings,
  testCount,
}: {
  findings: InvestigationFinding[];
  /** The report's own count of the tests this run reached a verdict on. */
  testCount: number;
}) {
  // `actionable` is exactly the client-bug plane, `coverage` is the non-blocking plane, and passed is the app-health
  // remainder (an unknown category falls back to coverage).
  const bugCount = findings.filter((f) => analysisVerdictMeta(f.category).actionable).length;
  const coverageCount = findings.filter((f) => analysisVerdictMeta(f.category).plane === "coverage").length;
  const passedCount = findings.length - bugCount - coverageCount;
  const state = deriveAnalysisVerdict({
    bugCount,
    coverageGapCount: coverageCount,
    // "Did anything run" is answered by the report, which is the durable projection - a discarded generation takes
    // its finding's classification with it, so an empty findings list is not proof the run exercised nothing. Every
    // surface reads this same count, which is what keeps them from disagreeing.
    investigatedCount: testCount,
  });
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
