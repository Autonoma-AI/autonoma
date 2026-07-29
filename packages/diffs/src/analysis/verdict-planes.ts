import { type CoverageSummary, coverageVerdicts } from "@autonoma/types";

export type { CoverageCategoryCount, CoverageSummary } from "@autonoma/types";

/** The app-health headline for a PR: `client_bug` (a true positive against the PR) or `passed`. */
export type AppHealthVerdict = "client_bug" | "passed";

/** The finalized two-plane verdict: the app-health headline and the coverage-confidence summary. */
export interface TwoPlaneSummary {
    /** App-health plane: `client_bug` if any finding is one, else `passed`. Only this blocks the PR. */
    verdict: AppHealthVerdict;
    coverage: CoverageSummary;
}

/**
 * Derive the two-plane verdict from the run's per-test terminal verdicts - deterministically, in code, never by a
 * model. The app-health plane is the headline (`client_bug` iff any finding is one); the coverage plane is everything
 * else, summarized per category (including `plan_mismatch`, the tests the run could not stabilize but kept).
 *
 * Takes the verdicts themselves: each finding is one test's verdict, so nothing else about a finding affects the
 * summary.
 */
export function summarizeVerdictPlanes(categories: readonly string[]): TwoPlaneSummary {
    const verdict: AppHealthVerdict = categories.includes("client_bug") ? "client_bug" : "passed";

    const byCategory = coverageVerdicts
        .map((category) => ({ category, count: categories.filter((entry) => entry === category).length }))
        .filter((entry) => entry.count > 0);
    const total = byCategory.reduce((sum, entry) => sum + entry.count, 0);

    return { verdict, coverage: { byCategory, total } };
}
