import { type ApplyChangeParams, TestSuiteChange } from "./test-suite-change";

export interface QuarantineTestParams {
    testCaseId: string;
    issueId: string;
}

export class QuarantineTest extends TestSuiteChange<QuarantineTestParams> {
    async apply({ snapshotDraft }: ApplyChangeParams): Promise<void> {
        await snapshotDraft.quarantineTestCase(this.params.testCaseId, this.params.issueId);
    }
}
