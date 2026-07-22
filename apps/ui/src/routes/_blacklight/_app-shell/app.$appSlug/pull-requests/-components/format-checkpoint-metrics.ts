import type { CheckpointAnalysisSummary, CheckpointPresentationSummary } from "@autonoma/types";
import { unresolvedLabel } from "./outcome-vocab";

// Builds the one-line test-result summary shown under each checkpoint row in the
// history (PR list + PR detail) - e.g. "2 failed · 1 passed · 3 bugs". Keys off the
// server-computed summary so the copy matches the badge instead of re-deriving from
// raw health counts. An authoritative snapshot (summary.analysis set) reads its counts
// from the AnalysisReport verdict buckets, not the legacy health model. fallbackTotalTests
// is used only when summary is undefined (health not yet computed).
export function formatCheckpointMetrics(
    summary: CheckpointPresentationSummary | undefined,
    bugCount: number,
    fallbackTotalTests: number,
): string {
    if (summary == null) return `${fallbackTotalTests} tests`;
    if (summary.analysis != null) return formatAuthoritativeMetrics(summary.analysis);

    const tc = summary.testCounts;
    const bugs = summary.openBugCount > 0 ? summary.openBugCount : bugCount;

    // No runs have executed yet: spell out why instead of a bare "N tests".
    if (summary.executionState === "not_started") {
        const segs = ["Not run yet"];
        if (tc.assigned > 0) segs.push(`${tc.assigned} to run`);
        return segs.join(" · ");
    }

    const parts: string[] = [];
    if (tc.failed > 0) parts.push(`${tc.failed} failed`);
    if (tc.setupFailed > 0) parts.push(`${tc.setupFailed} setup failed`);
    if (tc.running > 0) parts.push(`${tc.running} ${unresolvedLabel(summary.executionState)}`);
    if (tc.passed > 0) parts.push(`${tc.passed} passed`);
    if (bugs > 0) parts.push(`${bugs} ${bugs === 1 ? "bug" : "bugs"}`);

    if (parts.length > 0) return parts.join(" · ");
    return `${tc.assigned} tests`;
}

// The authoritative-analysis metrics line: client bugs, passed checks, and non-blocking coverage findings, keyed
// off the AnalysisReport buckets. While the run is analyzing (or the job failed) there is no breakdown to show.
function formatAuthoritativeMetrics(analysis: CheckpointAnalysisSummary): string {
    if (analysis.jobStatus === "failed") return "Analysis failed";
    if (analysis.jobStatus === "running") return "Analyzing";

    const parts: string[] = [];
    if (analysis.bugCount > 0) parts.push(`${analysis.bugCount} ${analysis.bugCount === 1 ? "bug" : "bugs"}`);
    if (analysis.passedCount > 0) parts.push(`${analysis.passedCount} passed`);
    if (analysis.coverageCount > 0) parts.push(`${analysis.coverageCount} couldn't confirm`);

    if (parts.length > 0) return parts.join(" · ");
    return "No tests analyzed";
}
