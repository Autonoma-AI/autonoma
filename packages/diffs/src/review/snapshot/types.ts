import type { AffectedReason } from "@autonoma/db";
import type { ScenarioData } from "../../scenario-data";
import type { IterationLineage, RenderableReviewStep } from "../kernel";

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
 * Carries every replayed run regardless of outcome - passed or lacking a
 * completed review. Consumers (resolution today, healing next) apply their own
 * actionability filter; the loader's job is to gather, not to judge.
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
     * Point-in-time refinement-loop history for this run, one entry per iteration.
     * Resolution runs at Step 3, before any refinement loop, so this is virtually
     * always empty; carried for parity with the reviewer context and healing's reuse.
     */
    lineage: IterationLineage[];
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
    /**
     * The diff anchor (base/head SHAs) shared by every run. Absent for a SHA-less
     * snapshot. Resolution, this scope's only consumer, does not read it.
     */
    change?: SnapshotChangeContext;
    /**
     * `DiffsJob.analysisReasoning` - the diffs-agent's summary of what changed. A
     * snapshot-level fact independent of SHA presence, carried even when
     * {@link change} is absent. Always set: resolution runs downstream of a
     * successful analysis. Empty string when analysis recorded no summary.
     */
    analysisReasoning: string;
    /** One entry per replayed, flagged run in the snapshot. */
    runs: SnapshotRunContext[];
}

/**
 * The lean descriptor the healing loader needs to gather one failing subject's
 * diff-job context. A healing iteration's failures are already known (the
 * workflow bucketed them) - unlike snapshot scope, the loader does not discover
 * them - so it only needs enough to anchor the lineage walk, resolve the right
 * scenario, and look up why the test was flagged.
 *
 * `sourceId` is the failing subject's primary key: a `generationId` for a
 * generation-stage failure, a `runId` for a replay-stage failure. `source`
 * selects which scenario resolver to use; `planId` + `testCaseId` anchor the
 * per-test lineage walk.
 */
export interface HealingFailureSubject {
    /** Stable key the assembler merges the gathered context back onto its `FailureRecord`. */
    failureKey: string;
    source: "generation" | "replay";
    /** `generationId` for a generation failure, `runId` for a replay failure. */
    sourceId: string;
    /** The plan the failing subject executed - anchors its refinement iteration. */
    planId: string;
    testCaseId: string;
}

/**
 * The diff-job context the loader gathered for one healing failure subject,
 * carried back to the assembler by {@link HealingFailureSubject.failureKey}.
 * `affectedReason`/`affectedReasoning` are optional (a subject may not be a
 * flagged test) and `scenario` is optional (a subject may have run without one);
 * `lineage` is empty for first-iteration failures and failures outside any loop.
 */
export interface HealingSubjectContext {
    /** Matches the originating {@link HealingFailureSubject.failureKey}. */
    failureKey: string;
    /** `AffectedTest.affectedReason` for this test - the category it was flagged under. */
    affectedReason?: AffectedReason;
    /** `AffectedTest.reasoning` - the diffs-agent's explanation for flagging this test. */
    affectedReasoning?: string;
    /**
     * Point-in-time refinement-loop history for this test, one entry per iteration
     * (the plan it scoped and the verdicts it reached), oldest first. Empty for
     * first-iteration failures and failures outside any loop. Healing's
     * highest-value addition - it lets the agent avoid re-trying strategies that
     * already failed earlier.
     */
    lineage: IterationLineage[];
    /**
     * Materialized snapshot of the data the failing subject's scenario actually
     * created. Resolved via the shared scenario-data capability (the same path
     * the reviewers and resolution use). Absent when the subject had no scenario,
     * UP never succeeded, or the generated-data graph was empty.
     */
    scenario?: ScenarioData;
    /**
     * The subject's executed steps (screenshot keys + step-output text), sourced
     * the same way the reviewers get theirs (the generation `StepAttempt`
     * timeline, or the replay `StepOutput` list). The healing agent's
     * `fetch_step_evidence` tool resolves the screenshot bytes for a given step
     * on demand. Empty when the subject persisted no steps.
     */
    steps: RenderableReviewStep[];
}

/**
 * Healing-scope sibling of {@link SnapshotContext}: the unified diff-job context
 * for one refinement iteration's failing subjects, gathered once at setup so the
 * agent run stays DB-free. Carries the snapshot-level change facts shared by
 * every failure plus the per-subject enrichment.
 *
 * Unlike snapshot scope, the failing subjects are supplied by the caller (the
 * workflow already bucketed them) rather than discovered from `AffectedTest`,
 * because healing failures include generation-stage failures that have no run.
 */
export interface HealingContext {
    snapshotId: string;
    organizationId: string;
    /** The application the snapshot belongs to - the assembler's side-inputs key off it. */
    applicationId: string;
    /**
     * The diff anchor (base/head SHAs) shared by every failure. Absent for a
     * SHA-less snapshot; the healing prompt builder asserts its presence.
     */
    change?: SnapshotChangeContext;
    /**
     * `DiffsJob.analysisReasoning` - the diffs-agent's summary of what changed. A
     * snapshot-level fact independent of SHA presence, carried even when
     * {@link change} is absent. Always set: healing runs downstream of a successful
     * analysis. Empty string when analysis recorded no summary.
     */
    analysisReasoning: string;
    /** One entry per supplied failing subject, keyed back by `failureKey`. */
    subjects: HealingSubjectContext[];
}
