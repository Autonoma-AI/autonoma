/**
 * The one place that decides WHICH run an issue points at.
 *
 * An issue is branch-scoped and can be reproduced by many runs; every surface that offers to show "the" reproduction
 * (the PR comment's clip and "Watch replay", the MCP payload's `replayUrl`) has to pick the same one, or two readers
 * of the same issue are sent to different runs. The rule lives here for the same reason the link shapes live in
 * `app-links.ts`: it is shared policy, and a change to it must reach every surface at once.
 */

/**
 * The shape this rule needs from a finding: which test it is about, and when its run happened (findings key to the
 * `AnalysisJob`, so the timestamp comes via the job's snapshot). Structural, so each caller keeps its own row type
 * and gets it back unchanged.
 */
export interface DesignatableFinding {
    testCaseId: string;
    job: { snapshot: { createdAt: Date } };
}

/**
 * The run to feature for an issue: the NEWEST finding for the test the Reporter designated as its clearest
 * reproduction. The agent chose the test; picking its latest run is mechanical, and doing it on read is what makes a
 * carried-forward issue's clip and deep-links track the PR's current head with no re-designation.
 *
 * Absent when the issue predates the designation, or when the designated test has no attributed finding - a caller
 * should then fall back to the issue's own hero frame and offer no replay, rather than featuring a run nobody picked.
 */
export function pickDesignatedRun<T extends DesignatableFinding>(
    primaryTestCaseId: string | undefined,
    findings: readonly T[],
): T | undefined {
    if (primaryTestCaseId == null) return undefined;
    const matching = findings.filter((finding) => finding.testCaseId === primaryTestCaseId);
    return matching.reduce<T | undefined>((newest, finding) => {
        if (newest == null) return finding;
        return finding.job.snapshot.createdAt > newest.job.snapshot.createdAt ? finding : newest;
    }, undefined);
}
