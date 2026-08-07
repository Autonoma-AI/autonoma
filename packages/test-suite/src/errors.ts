export class BranchNotFoundError extends Error {
    constructor(branchId: string) {
        super(`Branch ${branchId} not found or does not belong to the specified organization`);
        this.name = "BranchNotFoundError";
    }
}

/** The branch already has an open (processing) snapshot; a new one cannot be opened until it settles. */
export class BranchAlreadyOpenError extends Error {
    constructor(
        public readonly branchId: string,
        /** The snapshot currently open on the branch - what a superseding caller settles before retrying. */
        public readonly pendingSnapshotId: string,
    ) {
        super(`Branch ${branchId} already has an open snapshot (${pendingSnapshotId})`);
        this.name = "BranchAlreadyOpenError";
    }
}

export class SnapshotNotFoundError extends Error {
    constructor(snapshotId: string) {
        super(`Snapshot ${snapshotId} not found`);
        this.name = "SnapshotNotFoundError";
    }
}

/** The snapshot exists but is no longer open: it reached a terminal status and is immutable. */
export class SnapshotNotOpenError extends Error {
    constructor(
        public readonly snapshotId: string,
        public readonly status: string,
    ) {
        super(`Snapshot ${snapshotId} is not open (status: ${status})`);
        this.name = "SnapshotNotOpenError";
    }
}

/** No base sha could be derived: the source snapshot records no head and the source carried no fallback. */
export class NoSnapshotBaseError extends Error {
    constructor(branchId: string) {
        super(`Branch ${branchId} has no derivable base sha for a new snapshot`);
        this.name = "NoSnapshotBaseError";
    }
}

/** The snapshot does not assign the test, so there is nothing to run, revise, or restore. */
export class TestNotAssignedError extends Error {
    constructor(snapshotId: string, testCaseId: string) {
        super(`Snapshot ${snapshotId} does not assign test case ${testCaseId}`);
        this.name = "TestNotAssignedError";
    }
}

/** The assignment exists but pins no plan, so there is nothing to resolve a run from. */
export class TestPlanMissingError extends Error {
    constructor(snapshotId: string, testCaseId: string) {
        super(`Test case ${testCaseId} has no plan pinned on snapshot ${snapshotId}`);
        this.name = "TestPlanMissingError";
    }
}

/**
 * The branch's active snapshot moved between the source being resolved and the open taking the branch lock, so
 * the source describes a lineage the branch has left. Opening anyway would fork from a superseded snapshot and
 * silently discard whatever the promotion carried. Re-resolve and retry.
 */
export class SourceMovedError extends Error {
    constructor(
        public readonly branchId: string,
        /** The active snapshot the source was resolved against; absent when it was resolved against none. */
        public readonly expectedActiveSnapshotId: string | undefined,
        public readonly actualActiveSnapshotId: string | undefined,
    ) {
        super(
            `Branch ${branchId} moved its active snapshot while a source was being resolved ` +
                `(expected ${expectedActiveSnapshotId ?? "none"}, found ${actualActiveSnapshotId ?? "none"})`,
        );
        this.name = "SourceMovedError";
    }
}

/** Forking from it would import another application's suite, so the open is refused. */
export class ForeignSourceSnapshotError extends Error {
    constructor(
        public readonly sourceSnapshotId: string,
        public readonly branchId: string,
    ) {
        super(
            `Source snapshot ${sourceSnapshotId} belongs to another application; refusing to fork branch ${branchId} from it`,
        );
        this.name = "ForeignSourceSnapshotError";
    }
}

export class SlugAllocationError extends Error {
    constructor(
        public readonly name_: string,
        public readonly attempts: number,
    ) {
        super(`Could not mint a unique slug for test "${name_}" after ${attempts} attempts`);
        this.name = "SlugAllocationError";
    }
}

/** Restoring it would repoint the assignment at another test. */
export class PlanNotOnTestCaseError extends Error {
    constructor(
        public readonly planId: string,
        public readonly testCaseId: string,
    ) {
        super(`Plan ${planId} does not belong to test case ${testCaseId}`);
        this.name = "PlanNotOnTestCaseError";
    }
}
