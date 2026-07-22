import { type CoverageSummary, coverageVerdicts } from "@autonoma/types";
import type { ReconciledAnalysisFinding } from "./dedup";

export type { CoverageCategoryCount, CoverageSummary } from "@autonoma/types";

/** The app-health headline for a PR: `client_bug` (a true positive against the PR) or `passed`. */
export type AppHealthVerdict = "client_bug" | "passed";

/** The finalized two-plane verdict: the app-health headline and the coverage-confidence summary. */
export interface TwoPlaneSummary {
    /** App-health plane: `client_bug` if any deduped finding is one, else `passed`. Only this blocks the PR. */
    verdict: AppHealthVerdict;
    coverage: CoverageSummary;
}

/**
 * Derive the two-plane verdict from the FINALIZED (deduped) finding set - deterministically, in code, never by a
 * model. The app-health plane is the headline (`client_bug` iff any finding is one); the coverage plane is
 * everything else, summarized per category plus the delete-origin split (proposed tests the run could not
 * establish vs pre-existing tests removed as obsolete), read straight off each finding's members' `origin` tag.
 */
export function summarizeVerdictPlanes(findings: ReconciledAnalysisFinding[]): TwoPlaneSummary {
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

    const deleteMembers = findings
        .flatMap((finding) => finding.members)
        .filter((member) => member.category === "delete");
    const unestablishedProposed = deleteMembers.filter((member) => member.origin === "proposed").length;
    const obsoleteRemoved = deleteMembers.filter((member) => member.origin === "pre_existing").length;

    return { verdict, coverage: { byCategory, total, unestablishedProposed, obsoleteRemoved } };
}
