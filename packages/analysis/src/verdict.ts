import {
    type AnalysisPrVerdictInput,
    type AnalysisVerdictCounts,
    type AnalysisVerdictState,
    tallyAnalysisFlows,
} from "@autonoma/types";

/**
 * Classify a PR's counts into the single verdict every surface renders. Deliberately NOT exported past this package:
 * a caller holding the bare formula picks its own three integers, which is how the surfaces drifted apart in the
 * first place. Ask {@link BranchLedger.verdict} instead - it answers with the counts it used.
 *
 * A run that reached no verdict is `no_tests_needed` even when the branch carries coverage gaps: those are earlier
 * runs' and this one cleared none of them, so they must not downgrade a decision it made deliberately.
 */
export function deriveAnalysisVerdict(counts: AnalysisVerdictCounts): AnalysisVerdictState {
    if (counts.bugCount > 0) return "bug_found";
    if (counts.investigatedCount === 0) return "no_tests_needed";
    if (counts.coverageGapCount > 0) return "not_confirmed";
    return "healthy";
}

/**
 * The PR-level verdict. Every PR-level surface reads the same persisted flows and the same open-bug count, so they
 * agree by construction - that is the fix for the surfaces drifting apart, where the PR page and the GitHub comment
 * fed the verdict from different things and landed on different states for the same run.
 *
 * An ABSENT itemization is not an empty one. Every report written before this feature has `flows = NULL`, which both
 * read boundaries turn into `[]`; deriving "nothing needed testing" from that would render a green no-tests verdict
 * over a run that investigated a dozen tests and left half of them unconfirmed. So an absent itemization falls back
 * to the counts every surface used before it, which are still on the row.
 */
export function derivePrVerdict(input: AnalysisPrVerdictInput): AnalysisVerdictState {
    if (input.flows.length === 0) {
        return deriveAnalysisVerdict({
            bugCount: input.openBugCount,
            coverageGapCount: input.coverageGapCount,
            investigatedCount: input.investigatedCount,
        });
    }
    const tally = tallyAnalysisFlows(input.flows);
    return deriveAnalysisVerdict({
        bugCount: input.openBugCount,
        coverageGapCount: tally.total - tally.verified,
        investigatedCount: tally.total,
    });
}
