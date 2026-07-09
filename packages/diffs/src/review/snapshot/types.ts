import type { AffectedReason } from "@autonoma/db";
import type { ScenarioData } from "../../scenario-data";
import type { IterationLineage, RenderableReviewStep } from "../kernel";

/**
 * The SHAs that bound the snapshot's diff, shared by every failing subject in it.
 * Deliberately just the diff anchor: the diffs-agent's analysis reasoning is a
 * snapshot-level fact independent of SHA presence, so it lives on
 * {@link HealingContext} directly rather than here, and the per-subject
 * `affectedReason`/`affectedReasoning` live on each {@link HealingSubjectContext}.
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
 * The lean descriptor the healing loader needs to gather one failing subject's
 * diff-job context. A healing iteration's failures are already known (the
 * workflow bucketed them) - unlike snapshot scope, the loader does not discover
 * them - so it only needs enough to anchor the lineage walk, resolve the right
 * scenario, and look up why the test was flagged.
 *
 * `sourceId` is the failing subject's primary key: the `generationId` of the
 * failing generation. `planId` + `testCaseId` anchor the per-test lineage walk.
 */
export interface HealingFailureSubject {
    /** Stable key the assembler merges the gathered context back onto its `FailureRecord`. */
    failureKey: string;
    /** The `generationId` of the failing generation. */
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
     * the same way the reviewer gets its own (the generation `StepAttempt`
     * timeline). The healing agent's `fetch_step_evidence` tool resolves the
     * screenshot bytes for a given step on demand. Empty when the subject
     * persisted no steps.
     */
    steps: RenderableReviewStep[];
}

/**
 * The unified diff-job context for one refinement iteration's failing subjects,
 * gathered once at setup so the agent run stays DB-free. Carries the
 * snapshot-level change facts shared by every failure plus the per-subject
 * enrichment.
 *
 * The failing subjects are supplied by the caller (the workflow already bucketed
 * them) rather than discovered from `AffectedTest`.
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
