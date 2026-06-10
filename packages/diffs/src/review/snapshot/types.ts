import type { AffectedReason } from "@autonoma/db";
import type { ScenarioData } from "../../scenario-data";
import type { ReviewLineage } from "../kernel";

/**
 * The SHAs that bound the snapshot's diff, shared by every replayed run in it.
 * Deliberately just the diff anchor: the diffs-agent's analysis reasoning is a
 * snapshot-level fact independent of SHA presence, so it lives on
 * {@link SnapshotContext} directly rather than here, and the per-run
 * `affectedReason`/`affectedReasoning` live on each {@link SnapshotRunContext}.
 *
 * Omitted (the whole object is `undefined`) when the snapshot is missing its
 * SHAs: without them there is nothing to `git diff` against, exactly as the
 * reviewer's per-subject change context behaves.
 */
export interface SnapshotChangeContext {
    /** Commit the change is measured against (the diff's "before"). */
    baseSha: string;
    /** Commit under test (the diff's "after"). */
    headSha: string;
}

/**
 * A reviewer's completed verdict on a single replayed run. Present on a
 * {@link SnapshotRunContext} only when the run's `RunReview` reached `completed`
 * status - an in-progress or absent review carries no verdict.
 */
export interface SnapshotRunReview {
    /** The reviewer's attribution. Absent if a completed review recorded no verdict. */
    verdict?: string;
    /** The reviewer's free-text justification. Empty string if none was recorded. */
    reasoning: string;
    /** The linked issue's title, when the review opened one. */
    issueTitle?: string;
    /** The linked issue's description, when the review opened one. */
    issueDescription?: string;
}

/**
 * The diff-job context for a single replayed run inside a snapshot: which test
 * it executed, why the test was flagged, the reviewer's verdict, and the
 * materialized scenario data the run executed against. The same per-subject
 * facts a reviewer gets, but gathered across the whole snapshot.
 *
 * Carries every replayed run regardless of outcome - passed, quarantined, or
 * lacking a completed review. Consumers (resolution today, healing next) apply
 * their own actionability filter; the loader's job is to gather, not to judge.
 */
export interface SnapshotRunContext {
    runId: string;
    testCaseId: string;
    testSlug: string;
    testName: string;
    /** The plan prompt this run actually executed (point-in-time, read from `run.plan`). */
    testPlanPrompt: string;
    /** The run's terminal status (e.g. `failed`, `success`). */
    runStatus: string;
    /** Whether this test is quarantined in the baseline snapshot - quarantined tests are excluded from replay. */
    quarantined: boolean;
    /** Why the diffs-agent flagged this test. */
    affectedReason: AffectedReason;
    /** The diffs-agent's explanation for why this test was flagged. */
    affectedReasoning: string;
    /** The reviewer's completed verdict on this run, when one exists. */
    review?: SnapshotRunReview;
    /**
     * Materialized snapshot of the data the run's scenario actually created.
     * Omitted when the run has no scenario instance, UP never succeeded, or the
     * generated-data graph is empty - resolved via the shared scenario-data
     * capability so reviewers, resolution, and healing share one path.
     */
    scenario?: ScenarioData;
    /**
     * Point-in-time refinement-loop lineage for this run. Resolution runs at
     * Step 3, before any refinement loop, so this is virtually always absent;
     * carried for parity with the reviewer context and for healing's reuse.
     */
    lineage?: ReviewLineage;
}

/**
 * Everything a snapshot-scope agent needs, gathered across all replayed runs in
 * a single snapshot: the shared change facts plus the per-run context. Loaded
 * once by the `DiffJobContextLoader`, then passed around as a read-only value
 * object - the agent run itself stays DB-free.
 *
 * This is the snapshot-scope sibling of the per-subject `RunContext` /
 * `GenerationContext`: resolution consumes it today, healing builds on it next.
 */
export interface SnapshotContext {
    snapshotId: string;
    organizationId: string;
    /** The diff anchor (base/head SHAs) shared by every run. Absent when the snapshot has no SHAs. */
    change?: SnapshotChangeContext;
    /**
     * `DiffsJob.analysisReasoning` - the diffs-agent's natural-language summary of
     * what changed. A snapshot-level fact independent of SHA presence, so it is
     * carried even when {@link change} is absent. Undefined when analysis
     * recorded none (or no DiffsJob exists yet).
     */
    analysisReasoning?: string;
    /** One entry per replayed, flagged run in the snapshot. */
    runs: SnapshotRunContext[];
}
