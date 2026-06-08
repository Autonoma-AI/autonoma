import type { AffectedReason } from "@autonoma/db";

export interface RunStepData {
    order: number;
    interaction: string;
    params: unknown;
    output: unknown;
    screenshotBeforeKey?: string;
    screenshotAfterKey?: string;
}

/**
 * Subject-scoped facts about the code change that triggered this run's review,
 * gathered entirely from the database by `DiffJobContextLoader`.
 *
 * Deliberately carries only what is DB-sourced and **not** reproducible from
 * git: the SHAs bound the diff (so the reviewer knows what to `git diff`
 * against), the analysis reasoning is the diffs-agent's natural-language
 * summary of what changed, and the affected-reason/affected-reasoning pair is
 * why this specific test was flagged. The raw changed-file list and the diff
 * hunks are intentionally absent - the reviewer derives them itself via
 * `git diff <baseSha>..<headSha>` in bash.
 */
export interface ReplayChangeContext {
    /** Commit the change is measured against (the diff's "before"). */
    baseSha: string;
    /** Commit under test (the diff's "after"). */
    headSha: string;
    /** `DiffsJob.analysisReasoning` - the agent's summary of what changed and why. Absent if analysis recorded none. */
    analysisReasoning?: string;
    /** `AffectedTest.affectedReason` - the category under which this test was flagged. Absent if the test wasn't flagged. */
    affectedReason?: AffectedReason;
    /** `AffectedTest.reasoning` - the diffs-agent's explanation for why this test was flagged. Absent if the test wasn't flagged. */
    affectedReasoning?: string;
}

export interface RunContext {
    runId: string;
    organizationId: string;
    testPlanPrompt: string;
    testCaseName: string;
    steps: RunStepData[];
    videoS3Key?: string;
    finalScreenshotKey?: string;
    /**
     * DB-sourced facts about the code change under review. Optional so legacy
     * fixtures captured before change context existed still rehydrate; production
     * always populates it via `DiffJobContextLoader`.
     */
    change?: ReplayChangeContext;
}
