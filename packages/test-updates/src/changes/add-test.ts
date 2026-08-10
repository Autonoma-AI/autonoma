import { type ApplyChangeParams, TestSuiteChange } from "./test-suite-change";

export interface AddTestParams {
    name: string;
    /** Falsifiable behavioral claim, persisted as the test case's immutable `description`; the `scenario_unsupported` reviewer anchors on it. */
    description: string;
    plan: string;
    folderId: string;
    scenarioId?: string;
    scenarioName?: string;
}

export class AddTest extends TestSuiteChange<AddTestParams, { testCaseId: string; planId: string }> {
    async apply({ snapshotDraft }: ApplyChangeParams): Promise<{ testCaseId: string; planId: string }> {
        return await snapshotDraft.addTestCase(this.params);
    }
}
