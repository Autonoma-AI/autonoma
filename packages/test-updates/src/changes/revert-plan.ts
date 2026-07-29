import { type ApplyChangeParams, TestSuiteChange } from "./test-suite-change";

export interface RevertPlanParams {
    testCaseId: string;
    /** The plan record the assignment held before the edit being undone. */
    planId: string;
}

/**
 * Put back a plan the test already had, WITHOUT queuing a generation - the undo sibling of `UpdateTest` (which mints a
 * new plan AND enqueues a run). Used by the analysis Investigator when it keeps a `plan_mismatch`: the failed self-heal
 * rewrite must not be promoted, so the assignment is repointed at the pre-rewrite plan record, and no re-run is wanted
 * (the loop is over).
 *
 * It repoints rather than re-authoring the same text deliberately: the change computations key on `planId`, so minting
 * a fresh record would leave the test reading as `modified` with identical before/after plans. Restoring the original
 * id makes the snapshot genuinely unchanged, and the restored plan pins its own scenario, so nothing else is needed.
 */
export class RevertPlan extends TestSuiteChange<RevertPlanParams, void> {
    async apply({ snapshotDraft }: ApplyChangeParams): Promise<void> {
        await snapshotDraft.restorePlan(this.params);
    }
}
