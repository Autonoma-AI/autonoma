import { type ApplyChangeParams, TestSuiteChange } from "./test-suite-change";

export interface AddTestParams {
    name: string;
    description?: string;
    plan: string;
    folderId: string;
    scenarioId?: string;
}

export class AddTest extends TestSuiteChange<AddTestParams> {
    async apply({ snapshotDraft, generationManager }: ApplyChangeParams): Promise<void> {
        const { planId } = await snapshotDraft.addTestCase(this.params);

        await generationManager.addJob(planId);
    }
}
