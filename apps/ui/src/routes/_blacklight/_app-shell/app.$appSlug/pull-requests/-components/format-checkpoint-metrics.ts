import type { CheckpointPresentationSummary } from "@autonoma/types";
import { unresolvedLabel } from "./outcome-vocab";

// Builds the one-line test-result summary shown under each checkpoint row in the
// history (PR list + PR detail) - e.g. "2 failed · 1 passed · 3 bugs". Keys off the
// server-computed summary so the copy matches the badge instead of re-deriving from
// raw health counts. fallbackTotalTests is used only when summary is undefined
// (health not yet computed).
export function formatCheckpointMetrics(
    summary: CheckpointPresentationSummary | undefined,
    bugCount: number,
    fallbackTotalTests: number,
): string {
    if (summary == null) return `${fallbackTotalTests} tests`;

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
