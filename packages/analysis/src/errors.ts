export class AnalysisSnapshotNotFoundError extends Error {
    constructor(snapshotId: string) {
        super(`Snapshot ${snapshotId} not found; no analysis can be addressed on it`);
        this.name = "AnalysisSnapshotNotFoundError";
    }
}

/**
 * The settlement found a queued test with no verdict and no recorded containment - writing the report would
 * present a clean run over a test that silently never got judged.
 */
export class AnalysisCoverageGapError extends Error {
    constructor(snapshotId: string, queuedTestCount: number, coveredCount: number) {
        super(
            `Snapshot ${snapshotId} queued ${queuedTestCount} test(s) but only ${coveredCount} are covered by a ` +
                `verdict or a recorded containment; refusing to write a report`,
        );
        this.name = "AnalysisCoverageGapError";
    }
}

/** A reconciliation named an issue that does not exist on the analysis's branch. */
export class IssueNotOnBranchError extends Error {
    constructor(issueId: string, branchId: string) {
        super(`Issue ${issueId} does not exist on branch ${branchId}`);
        this.name = "IssueNotOnBranchError";
    }
}
