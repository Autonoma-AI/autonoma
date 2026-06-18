import { type ApplyChangeParams, TestSuiteChange } from "./test-suite-change";

export interface UpdateTestParams {
    testCaseId: string;
    plan: string;
    scenarioId?: string;
}

export class UpdateTest extends TestSuiteChange<UpdateTestParams, { planId: string; generationId: string }> {
    async apply({
        snapshotDraft,
        generationManager,
    }: ApplyChangeParams): Promise<{ planId: string; generationId: string }> {
        const { planId } = await snapshotDraft.updatePlan(this.params);

        const generationId = await generationManager.addJob(planId);

        return { planId, generationId };
    }
}
