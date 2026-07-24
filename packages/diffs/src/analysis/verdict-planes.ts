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
 * One finding as the plane summary reads it: its terminal verdict `category` and, for a `delete`, the `origin`
 * that tells an obsolete pre-existing test apart from an un-establishable proposed one. Each finding is one test's
 * verdict (the pipeline no longer merges findings), so counts are taken straight off the finding list.
 */
export interface VerdictPlaneFinding {
    category: string;
    origin?: string;
}

/**
 * Derive the two-plane verdict from the run's per-test findings - deterministically, in code, never by a model.
 * The app-health plane is the headline (`client_bug` iff any finding is one); the coverage plane is everything
 * else, summarized per category plus the delete-origin split (proposed tests the run could not establish vs
 * pre-existing tests removed as obsolete), read straight off each finding's `origin` tag.
 */
export function summarizeVerdictPlanes(findings: readonly VerdictPlaneFinding[]): TwoPlaneSummary {
    const verdict: AppHealthVerdict = findings.some((finding) => finding.category === "client_bug")
        ? "client_bug"
        : "passed";

    const byCategory = coverageVerdicts
        .map((category) => ({
            category,
            count: findings.filter((finding) => finding.category === category).length,
        }))
        .filter((entry) => entry.count > 0);
    const total = byCategory.reduce((sum, entry) => sum + entry.count, 0);

    const deleteFindings = findings.filter((finding) => finding.category === "delete");
    const unestablishedProposed = deleteFindings.filter((finding) => finding.origin === "proposed").length;
    const obsoleteRemoved = deleteFindings.filter((finding) => finding.origin === "pre_existing").length;

    return { verdict, coverage: { byCategory, total, unestablishedProposed, obsoleteRemoved } };
}
