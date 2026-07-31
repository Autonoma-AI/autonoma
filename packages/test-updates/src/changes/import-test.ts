import { type ApplyChangeParams, TestSuiteChange } from "./test-suite-change";

export interface ImportTestParams {
    /** An existing test case of this application that the snapshot does not assign yet. */
    testCaseId: string;
    plan: string;
    scenarioId?: string;
}

/**
 * Adopts an existing test case into this snapshot with the given plan and queues its generation.
 *
 * The merge flow's counterpart to `UpdateTest`, for the leg where the target snapshot holds no assignment for the
 * test yet: a test authored on a feature branch that has since merged into main. Deliberately NOT `AddTest` - the
 * `TestCase` already exists application-wide, so minting a second one would fork the test's identity (a new slug,
 * and none of the history the source branch already recorded against it).
 */
export class ImportTest extends TestSuiteChange<ImportTestParams, { planId: string; generationId: string }> {
    async apply({
        snapshotDraft,
        generationManager,
    }: ApplyChangeParams): Promise<{ planId: string; generationId: string }> {
        const { planId } = await snapshotDraft.importTestCase(this.params);

        const generationId = await generationManager.addJob(planId);

        return { planId, generationId };
    }
}
