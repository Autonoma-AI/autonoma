import type { AffectedReason, RunReviewVerdict } from "@autonoma/db";

/**
 * Subject-scoped facts about the code change that triggered a review, gathered
 * entirely from the database by the `DiffJobContextLoader`. Shared verbatim by
 * the replay (run) and generation reviewers - the change a reviewer must
 * attribute against is the same fact set regardless of which subject executed.
 *
 * Deliberately carries only what is DB-sourced and **not** reproducible from
 * git: the SHAs bound the diff (so the reviewer knows what to `git diff`
 * against), the analysis reasoning is the diffs-agent's natural-language
 * summary of what changed, and the affected-reason/affected-reasoning pair is
 * why this specific test was flagged. The raw changed-file list and the diff
 * hunks are intentionally absent - the reviewer derives them itself via
 * `git diff <baseSha>..<headSha>` in bash.
 */
export interface ChangeContext {
    /** Commit the change is measured against (the diff's "before"). */
    baseSha: string;
    /** Commit under test (the diff's "after"). */
    headSha: string;
    /**
     * `DiffsJob.analysisReasoning` - the diffs-agent's summary of what changed and
     * why. Always set: every consumer runs downstream of a successful analysis,
     * which writes it before the status leaves `analyzing`. Empty string when
     * analysis recorded no summary.
     */
    analysisReasoning: string;
    /** `AffectedTest.affectedReason` - the category under which this test was flagged. Absent if the test wasn't flagged. */
    affectedReason?: AffectedReason;
    /** `AffectedTest.reasoning` - the diffs-agent's explanation for why this test was flagged. Absent if the test wasn't flagged. */
    affectedReasoning?: string;
}

/**
 * A verdict one of an iteration's runs reached on this test. Framed as *fallible*
 * signal in the prompt: an earlier reviewer may have misattributed the failure,
 * and the healing agent may then have rewritten the plan on a mistaken theory, so
 * the reviewer must re-derive its own verdict rather than rubber-stamp it.
 */
export interface IterationVerdict {
    verdict: RunReviewVerdict;
    /** The review's free-text justification. Empty string if it recorded none. */
    reasoning: string;
}

/**
 * One iteration in the subject test's refinement-loop history: the plan that
 * iteration scoped for the test, and the completed verdicts that iteration's runs
 * reached. The point-in-time history is the array of these, oldest first, up to
 * and including the iteration the subject executed.
 */
export interface IterationLineage {
    /** The refinement iteration this plan was the analysis-scope input to. */
    iterationNumber: number;
    /** The plan prompt executed in that iteration. */
    prompt: string;
    /** The healing agent's reasoning for this rewrite. Absent for the seed plan (iteration 1). */
    healingReasoning?: string;
    /**
     * Completed verdicts from this iteration's runs. Empty for the subject's own
     * iteration (its review is the one in progress) and for any iteration whose
     * runs have no completed review.
     */
    verdicts: IterationVerdict[];
}
