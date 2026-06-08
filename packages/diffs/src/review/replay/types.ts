import type { AffectedReason, RunReviewVerdict } from "@autonoma/db";
import type { ScenarioData } from "../../scenario-data";

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

/**
 * A verdict an earlier refinement-loop iteration's review reached on this same
 * test. Point-in-time: only verdicts that already existed when the subject run
 * was reviewed appear here.
 *
 * These are deliberately framed as *fallible* signal in the prompt: an earlier
 * reviewer may have misattributed the failure, and the healing agent may then
 * have rewritten the plan on a mistaken theory. The reviewer must re-derive its
 * own verdict rather than rubber-stamp the loop's existing one.
 */
export interface PriorVerdict {
    /** The refinement iteration whose run produced this verdict. */
    iterationNumber: number;
    /** The earlier review's attribution. */
    verdict: RunReviewVerdict;
    /** The earlier review's free-text justification. Empty string if the review recorded none. */
    reasoning: string;
}

/**
 * One plan in the test's rewrite history within the refinement loop, oldest
 * first. The first entry is the seed plan (no healing reasoning); each later
 * entry is a healing rewrite. The last entry is the plan the subject run
 * actually executed - the "current healed plan".
 */
export interface PlanRevision {
    /** The refinement iteration this plan was the analysis-scope input to. */
    iterationNumber: number;
    /** The plan prompt executed in that iteration. */
    prompt: string;
    /**
     * The healing agent's reasoning for producing this rewrite. Absent for the
     * seed plan (iteration 1), which the healing agent did not author.
     */
    healingReasoning?: string;
}

/**
 * Point-in-time review lineage for the subject run, gathered from the refinement
 * loop the run belongs to. Present only for iteration-2+ reviews: first-iteration
 * reviews have no earlier verdicts and no plan rewrites, so the loader omits
 * lineage entirely (and legacy fixtures predate it).
 */
export interface ReviewLineage {
    /** Earlier iterations' verdicts on this test, oldest first. */
    priorVerdicts: PriorVerdict[];
    /**
     * The test's plan rewrite history within the loop, oldest first, up to and
     * including the plan the subject run executed. Has at least two entries when
     * present (the seed plan plus at least one healing rewrite).
     */
    planHistory: PlanRevision[];
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
    /**
     * Point-in-time refinement-loop lineage for this test: the prior verdicts and
     * the plan rewrite history. Absent for first-iteration reviews (no earlier
     * iterations) and for legacy fixtures captured before lineage existed.
     */
    lineage?: ReviewLineage;
    /**
     * Materialized snapshot of the data the run's scenario actually created.
     * Omitted when the run has no scenario instance, UP never succeeded, or the
     * generated-data graph is empty (e.g. historical instances predating #815).
     * A bounded summary is inlined into the prompt; full records are surfaced
     * on demand via the `read_scenario_entities` tool.
     */
    scenario?: ScenarioData;
}
