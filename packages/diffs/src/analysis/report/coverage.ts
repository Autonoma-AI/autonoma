import {
    ANALYSIS_VERDICT,
    type AnalysisIssueKind,
    type AnalysisVerdict,
    analysisCoverageOwner,
    analysisFindingBucket,
} from "@autonoma/types";
import type { RecordedIssueAction } from "./issue-actions";
import type { ReporterExistingIssue, ReporterFinding } from "./types";

/**
 * The finding category whose recurrence proves an open issue of each kind is STILL PRESENT - what "still failed"
 * means per class. A `Record` over the issue-kind SSOT, so a new kind is a compile error until recurrence is defined
 * for it.
 *
 * It has to be per kind, not per plane: an environment or scenario issue whose covering test hit the same fault again
 * is neither a bug (no carry-forward requirement) nor a pass (no resolve requirement), so a bug-only test would let
 * the agent leave it untouched. Carrying forward is also what RE-ATTRIBUTES this run's finding to the issue, and the
 * PR comment reads that attribution to tell an environment gap the reader must fix from one that is ours - so a lapse
 * here moves a live configuration gap into "nothing here is yours to fix".
 */
const RECURRENCE_CATEGORY: Record<AnalysisIssueKind, AnalysisVerdict> = {
    bug: ANALYSIS_VERDICT.client_bug,
    environment: ANALYSIS_VERDICT.environment_failure,
    scenario: ANALYSIS_VERDICT.scenario_issue,
};

/**
 * Whether a finding of this category MUST roll into an issue before the Reporter may finish. Two classes give the
 * Reporter no discretion, so leaving either uncovered would bury an actionable, client-fixable problem in a bare
 * coverage count:
 *   - `client_bug`: always a bug issue.
 *   - anything the client OWNS on the coverage plane (`analysisCoverageOwner` === "client", i.e. `scenario_issue`):
 *     the seeded data is theirs to fix on every run.
 *
 * `environment_failure` is deliberately NOT required, even though it maps to an issue kind. Its side is `undecided`,
 * and the ONLY signal of whether it is theirs or ours is whether the Reporter attributed it to an issue (see
 * `ReporterBranchTest.attributedToClientIssue`): forcing coverage would read every environment failure as the client's
 * and erase the "this one is ours, report it as colour" path. `engine_artifact`, `plan_mismatch` and `invalid_test`
 * map to no issue kind at all, so a bare count is the honest ceiling for them.
 *
 * Derived from `analysisFindingBucket` + `analysisCoverageOwner` rather than a hand-listed category set, so a new
 * client-owned coverage verdict is required automatically and this cannot drift from the taxonomy.
 */
function findingRequiresIssue(category: AnalysisVerdict): boolean {
    return analysisFindingBucket(category) === "bug" || analysisCoverageOwner(category) === "client";
}

/**
 * The three structural coverage guarantees the Reporter must satisfy before it may finish. They keep the LLM's
 * cross-time matching honest: the model still decides which issue a finding belongs to, but it cannot drop a client
 * bug or scenario gap, leave a fixed issue open, or silently let a still-failing issue lapse. Each violation becomes a
 * fixable tool error at finish, so the agent self-corrects in the same loop.
 */
export interface CoverageViolations {
    /** (1) Live findings this job produced that must roll into an issue (see {@link findingRequiresIssue}) but no issue covers. */
    uncoveredIssueFindingSlugs: string[];
    /** (2) Open issues whose whole covering set re-ran and passed, but which were not resolved. */
    unresolvedPassedIssueIds: string[];
    /**
     * (3) Open issues whose covering test(s) re-ran and hit the SAME problem again (see {@link RECURRENCE_CATEGORY}),
     * but which were not carried forward.
     */
    uncarriedFailingIssueIds: string[];
}

/** Whether any coverage guarantee is violated. */
export function hasCoverageViolations(v: CoverageViolations): boolean {
    return (
        v.uncoveredIssueFindingSlugs.length > 0 ||
        v.unresolvedPassedIssueIds.length > 0 ||
        v.uncarriedFailingIssueIds.length > 0
    );
}

/**
 * Compute the coverage violations for a finish attempt. Pure over its inputs so it stays unit-testable in
 * isolation; the reporter reaches it through {@link ReporterAgentLoop.checkCoverage}, which feeds its own state.
 *
 * One covering test that hit the issue's problem again forces carry-forward; a resolve is forced only when the whole
 * covered set re-ran and every one of those tests passed. A covering test that did not run, or that came back with a
 * different fault, says nothing about this issue's problem, so a resolve off its passing sibling would close a live
 * issue. Partial evidence is the agent's call (see `assertResolvable`), which is what can still close an issue whose
 * covered set will never fully re-run.
 *
 * "Still failed" is per issue KIND, not per plane (see {@link RECURRENCE_CATEGORY}): a covering test that came back
 * with a DIFFERENT fault than the one the issue is about (an engine artifact where an environment issue was) is
 * neither recurrence nor proof it is gone, so it leaves the issue alone.
 */
export function computeCoverageViolations(
    findings: readonly ReporterFinding[],
    existingIssues: readonly ReporterExistingIssue[],
    actions: readonly RecordedIssueAction[],
): CoverageViolations {
    const bucketBySlug = new Map(findings.map((f) => [f.slug, analysisFindingBucket(f.category)]));
    // Recurrence is an exact-category question (per issue kind), not a bucket one, so it needs the raw verdicts.
    const categoryBySlug = new Map(findings.map((f) => [f.slug, f.category]));

    const coveredSlugs = new Set<string>();
    const carriedForwardIds = new Set<string>();
    const resolvedIds = new Set<string>();
    for (const action of actions) {
        if (action.kind === "open" || action.kind === "carry_forward") {
            for (const slug of action.content.findingSlugs) coveredSlugs.add(slug);
        }
        if (action.kind === "carry_forward") carriedForwardIds.add(action.existingIssueId);
        if (action.kind === "resolve") resolvedIds.add(action.existingIssueId);
    }

    const uncoveredIssueFindingSlugs = findings
        .filter((f) => findingRequiresIssue(f.category) && !coveredSlugs.has(f.slug))
        .map((f) => f.slug);

    const unresolvedPassedIssueIds: string[] = [];
    const uncarriedFailingIssueIds: string[] = [];
    for (const issue of existingIssues) {
        if (issue.status !== "open") continue;
        // A slug with no finding this job looks up to `undefined` in both maps, which is what keeps a partly-run
        // covered set out of the fully-passed case below.
        const covering = [...new Set(issue.findingSlugs)];
        const recurred = RECURRENCE_CATEGORY[issue.kind];
        const stillFailing = covering.some((slug) => categoryBySlug.get(slug) === recurred);
        const fullyPassed = covering.length > 0 && covering.every((slug) => bucketBySlug.get(slug) === "passed");

        if (stillFailing) {
            if (!carriedForwardIds.has(issue.id)) uncarriedFailingIssueIds.push(issue.id);
        } else if (fullyPassed) {
            if (!resolvedIds.has(issue.id)) unresolvedPassedIssueIds.push(issue.id);
        }
    }

    return { uncoveredIssueFindingSlugs, unresolvedPassedIssueIds, uncarriedFailingIssueIds };
}
