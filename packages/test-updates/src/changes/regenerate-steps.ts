import { type ApplyChangeParams, TestSuiteChange } from "./test-suite-change";

export interface RegenerateStepsParams {
    testCaseId: string;
}

export class RegenerateSteps extends TestSuiteChange<RegenerateStepsParams, string> {
    /** Returns the id of the pending generation queued for the regenerated plan. */
    async apply({ snapshotDraft, generationManager }: ApplyChangeParams): Promise<string> {
        const { planId } = await snapshotDraft.resolvePlanId(this.params.testCaseId);

        return await generationManager.addJob(planId);
    }
}
