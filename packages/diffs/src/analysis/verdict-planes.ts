import { type AnalysisVerdict, type CoverageSummary, analysisVerdictSchema } from "@autonoma/types";
import type { ReconciledAnalysisFinding } from "./dedup";

export type { CoverageCategoryCount, CoverageSummary } from "@autonoma/types";

/**
 * The two planes the verdict taxonomy splits into. `app_health` is the only plane that counts against the PR;
 * `coverage` is the coverage-confidence plane (never a bug, never blocking).
 */
type VerdictPlane = "app_health" | "coverage";

/** The app-health headline for a PR: `client_bug` (a true positive against the PR) or `passed`. */
export type AppHealthVerdict = "client_bug" | "passed";

/**
 * Programmatic partition of the verdict taxonomy into its two planes. A `Record` over the `AnalysisVerdict`
 * SSOT, so adding a verdict is a compile error here until it is assigned a plane - a plane can never silently
 * omit a verdict or count one twice.
 */
const VERDICT_PLANE: Record<AnalysisVerdict, VerdictPlane> = {
    client_bug: "app_health",
    passed: "app_health",
    engine_artifact: "coverage",
    environment_failure: "coverage",
    scenario_issue: "coverage",
    delete: "coverage",
};

/** The coverage-plane verdicts, derived from the partition over the schema's option list (never hand-listed). */
const COVERAGE_VERDICTS: AnalysisVerdict[] = analysisVerdictSchema.options.filter(
    (verdict) => VERDICT_PLANE[verdict] === "coverage",
);

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

    const byCategory = COVERAGE_VERDICTS.map((category) => ({
        category,
        count: findings.filter((finding) => finding.category === category).length,
    })).filter((entry) => entry.count > 0);
    const total = byCategory.reduce((sum, entry) => sum + entry.count, 0);

    const deleteMembers = findings
        .flatMap((finding) => finding.members)
        .filter((member) => member.category === "delete");
    const unestablishedProposed = deleteMembers.filter((member) => member.origin === "proposed").length;
    const obsoleteRemoved = deleteMembers.filter((member) => member.origin === "pre_existing").length;

    return { verdict, coverage: { byCategory, total, unestablishedProposed, obsoleteRemoved } };
}
