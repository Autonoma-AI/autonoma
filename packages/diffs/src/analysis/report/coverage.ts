import { analysisFindingBucket } from "@autonoma/types";
import type { RecordedIssueAction } from "./issue-actions";
import type { ReporterExistingIssue, ReporterFinding } from "./types";

/**
 * The three structural coverage guarantees the Reporter must satisfy before it may finish. They keep the LLM's
 * cross-time matching honest: the model still decides which issue a finding belongs to, but it cannot drop a bug,
 * leave a fixed issue open, or silently let a still-failing issue lapse. Each violation becomes a fixable tool
 * error at finish, so the agent self-corrects in the same loop.
 */
export interface CoverageViolations {
    /** (1) Live `client_bug` findings this job produced that no issue covers. */
    uncoveredBugSlugs: string[];
    /** (2) Open issues whose covering test(s) re-ran and passed, but which were not resolved. */
    unresolvedPassedIssueIds: string[];
    /** (3) Open issues whose covering test(s) re-ran and still failed, but which were not carried forward. */
    uncarriedFailingIssueIds: string[];
}

/** Whether any coverage guarantee is violated. */
export function hasCoverageViolations(v: CoverageViolations): boolean {
    return (
        v.uncoveredBugSlugs.length > 0 || v.unresolvedPassedIssueIds.length > 0 || v.uncarriedFailingIssueIds.length > 0
    );
}

/**
 * Compute the coverage violations for a finish attempt. Pure over its inputs so it stays unit-testable in
 * isolation; the reporter reaches it through {@link ReporterAgentLoop.checkCoverage}, which feeds its own state.
 * A covering test that "ran + passed" and one that "ran + still-failed" are mutually exclusive by construction:
 * a still-failing covering test forces carry-forward (check 3) and suppresses the resolve requirement (check 2),
 * so an issue whose covering tests are split (one passed, one still failing) is carried forward, never resolved.
 */
export function computeCoverageViolations(
    findings: readonly ReporterFinding[],
    existingIssues: readonly ReporterExistingIssue[],
    actions: readonly RecordedIssueAction[],
): CoverageViolations {
    const bucketBySlug = new Map(findings.map((f) => [f.slug, analysisFindingBucket(f.category)]));

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

    const uncoveredBugSlugs = findings
        .filter((f) => bucketBySlug.get(f.slug) === "bug" && !coveredSlugs.has(f.slug))
        .map((f) => f.slug);

    const unresolvedPassedIssueIds: string[] = [];
    const uncarriedFailingIssueIds: string[] = [];
    for (const issue of existingIssues) {
        if (issue.status !== "open") continue;
        const coveringRan = issue.findingSlugs.filter((slug) => bucketBySlug.has(slug));
        const stillFailing = coveringRan.some((slug) => bucketBySlug.get(slug) === "bug");
        const passed = coveringRan.some((slug) => bucketBySlug.get(slug) === "passed");

        if (stillFailing) {
            if (!carriedForwardIds.has(issue.id)) uncarriedFailingIssueIds.push(issue.id);
        } else if (passed) {
            if (!resolvedIds.has(issue.id)) unresolvedPassedIssueIds.push(issue.id);
        }
    }

    return { uncoveredBugSlugs, unresolvedPassedIssueIds, uncarriedFailingIssueIds };
}
