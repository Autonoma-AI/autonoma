import type {
    AnalysisClassificationReport,
    AnalysisRunOutcome,
    AnalysisTestOrigin,
    AnalysisVerdict,
} from "@autonoma/types";

/**
 * The merged analysis pipeline's activities (run on the DIFFS task queue). The pipeline IS the PR-analysis
 * pipeline for an org that has it enabled: Impact Analysis selects + materializes the affected/proposed tests on
 * the branch's real pending snapshot, the Investigators run + classify them and each persists its OWN finding, the
 * Reporter reconciles those findings into branch-scoped issues + authors the report (verdict, counts, prose), and
 * finalize promotes the snapshot + marks the job terminal. It replaces the diffs job for that org; whether it runs
 * at all is gated by the per-org flag + the global master switch at the trigger.
 */

/** One test the Impact Analysis stage selects for an Investigator to run + classify. */
export interface AnalysisInvestigationTarget {
    slug: string;
    /** The test itself. The finding is keyed on this; the slug is only the handle the classifier and the
     * snapshot's own row-local edits speak. */
    testCaseId: string;
    /** The generation the Investigator runs (created up front by the selection). */
    testGenerationId: string;
    /** The scenario to provision before the run, when the test pins one. */
    scenarioId?: string;
    /** Why this test was selected - fed to the classifier as context. */
    reason: string;
    /** Whether this test pre-existed (affected) or was authored this run (proposed) - set at materialization. */
    origin: AnalysisTestOrigin;
}

export interface OpenMergeGateInput {
    /** The branch's real pending snapshot the run operates on. */
    snapshotId: string;
}

export interface OpenMergeGateOutput {
    /** `opened` when the un-requested check was flipped to in-progress; `skipped` otherwise (best-effort). */
    status: "opened" | "skipped";
}

export interface RunImpactAnalysisInput {
    /** The branch's real pending snapshot the pipeline operates on. */
    snapshotId: string;
}

export interface RunImpactAnalysisOutput {
    /** The diff-affected tests to fan out one Investigator over each. */
    targets: AnalysisInvestigationTarget[];
    /** The stage's account of WHY it selected this set (affected + proposed). Persisted onto the AnalysisReport
     * by the Reporter. Optional: absent when selection produced no reasoning. */
    reasoning?: string;
}

/**
 * One iteration's outcome, as the Investigator hands it to `persistAnalysisClassification`. Every run+classify
 * iteration produces one - including the ones a self-heal supersedes, which is what keeps the verdict that authored
 * a rewrite auditable after the rewrite replaces it. The parent produces one too, to contain a crashed child.
 */
export interface AnalysisCandidateClassification {
    /** The generation this iteration ran and judged. */
    generationId: string;
    /**
     * The verdict this iteration reached. A self-heal iteration and the terminal it settles on both carry
     * `plan_mismatch`, so every stored category is a valid `AnalysisVerdict`.
     */
    category: AnalysisVerdict;
    headline: string;
    /**
     * The classifier's full rich output for this run (narrative, evidence, run-trace frames, media keys). Absent
     * for a contained scenario/classify fault, which never reached a classifier verdict at all.
     */
    report?: AnalysisClassificationReport;
}

/**
 * The terminal outcome an Investigator reports upward for its one test, for the parent's logging and the run
 * summary. The rows are already on disk by the time this is returned - each iteration persisted its own
 * classification as it happened - so this carries no evidence, only the conclusion.
 */
export interface AnalysisCandidateFinding {
    slug: string;
    testCaseId: string;
    /** The generation whose run produced the terminal verdict - the LAST iteration's. */
    generationId: string;
    /** The Investigator's terminal verdict (the full two-plane taxonomy). Never the transient loop-routing signal
     * that drives self-heal - that resolves to a re-run or, when exhausted, to a kept `plan_mismatch`. */
    category: AnalysisVerdict;
    headline: string;
    /**
     * Whether the test pre-existed (affected) or was authored this run (proposed). A narration-only data tag: it
     * lets the report tell a proposed test the run could not establish apart from a pre-existing one.
     */
    origin: AnalysisTestOrigin;
}

export interface PersistAnalysisClassificationInput {
    /** The snapshot the run operates on (the finding's report/job share this PK). */
    snapshotId: string;
    /** The test this classification is about - the finding it lands on is keyed on it. */
    testCaseId: string;
    /** Whether the test pre-existed or was authored this run. Set on the finding at its birth. */
    origin: AnalysisTestOrigin;
    /** Why Impact Analysis selected this test - the per-test provenance the Reporter reads as context. */
    selectionReason?: string;
    /**
     * Which slot of the self-heal loop this outcome occupies, 1-based - the caller's own iteration counter, never
     * derived from what is already stored. It is the write's idempotency key: filing the same slot twice restates
     * that row instead of appending a second one, so a re-execution can never invent a self-heal that never ran.
     * A crashed child's containment lands on `CONTAINMENT_CLASSIFICATION_NUMBER`, past every real iteration.
     */
    number: number;
    /** The iteration's outcome. */
    classification: AnalysisCandidateClassification;
}

export interface PersistAnalysisClassificationOutput {
    /** The finding this classification landed on (created on the first iteration, reused by the rest). */
    findingId: string;
    /** The slot it was recorded under - the `number` that was passed in. */
    number: number;
}

export interface RunReporterInput {
    snapshotId: string;
    /** The Impact Analysis stage's selection reasoning, persisted onto the AnalysisReport. Optional: absent when
     * the stage produced none. */
    impactReasoning?: string;
}

export interface RunReporterOutput {
    /** New branch-scoped issues the Reporter opened this run. */
    issuesOpened: number;
    /** Existing issues the Reporter carried forward (re-confirmed / reopened) this run. */
    issuesCarried: number;
    /** Existing issues the Reporter resolved (a covering test re-ran and passed) this run. */
    issuesResolved: number;
    /** The app-health verdict authored onto the report: `client_bug` if the branch has open bugs, else `passed`. */
    verdict: string;
    /** The branch's open bug-kind issue count, authored onto the report as `clientBugCount`. */
    clientBugCount: number;
}

export interface SettleAnalysisRunInput {
    snapshotId: string;
    outcome: AnalysisRunOutcome;
}

export interface SettleAnalysisRunOutput {
    settled: boolean;
    generationsFailed: number;
    discardedChangeCount: number;
}

export interface SelfHealAnalysisTestInput {
    /** The snapshot the test's rows live on. */
    snapshotId: string;
    /** The test whose plan to rewrite (its own (snapshot, testCase) rows). */
    slug: string;
    /** The classifier's COMPLETE revised plan to author onto the test. */
    plan: string;
}

/**
 * Either the rewrite landed and is undoable, or nothing was touched. The two arms exist so "a rewrite was applied"
 * and "we know the plan to restore" cannot come apart: a rewrite is only ever applied when it can be reverted, so
 * `previousPlanId` is REQUIRED on the prepared arm rather than another optional the caller has to defend against.
 */
export type SelfHealAnalysisTestOutput =
    | {
          prepared: true;
          /** A fresh pending generation to re-run + re-classify. */
          testGenerationId: string;
          /** The plan record the assignment pointed at BEFORE this rewrite - what `revertSelfHealPlan` restores. */
          previousPlanId: string;
          /** The scenario the rewritten plan pins (preserved from the test's current plan), when it pins one. */
          scenarioId?: string;
      }
    | {
          prepared: false;
          /** Why nothing was rewritten - no assignment for the slug, or it pinned no plan to restore afterwards. */
          skippedReason: string;
      };

export interface RevertSelfHealPlanInput {
    /** The snapshot the test's rows live on. */
    snapshotId: string;
    /** The test whose plan to restore (its own (snapshot, testCase) rows). */
    slug: string;
    /**
     * The plan record the assignment held before the self-heal rewrite (`previousPlanId` from that same rewrite). The
     * assignment is repointed at it rather than re-authoring its text, so the snapshot reads as unchanged for this
     * test. No generation is queued - the loop is over.
     */
    planId: string;
}

export interface RevertSelfHealPlanOutput {
    /** Whether the plan was restored (false when the slug has no assignment on the snapshot). */
    reverted: boolean;
    /** Why nothing was reverted, when `reverted` is false. */
    reason?: string;
}

export interface DeleteAnalysisTestInput {
    /** The snapshot the test's assignment lives on. */
    snapshotId: string;
    /** The test whose assignment to remove from the snapshot. */
    slug: string;
}

export interface DeleteAnalysisTestOutput {
    /** Whether an assignment was actually removed (false when the slug had no assignment on the snapshot). */
    deleted: boolean;
    /** Why nothing was removed, when `deleted` is false. */
    reason?: string;
}

/**
 * The parent stages of the merged analysis pipeline plus its one terminal settlement activity. The settlement
 * owns the snapshot, generation, job, merge-gate, and PR-comment protocol so no workflow exit can leave an
 * incomplete run behind.
 */
export interface AnalysisActivities {
    /**
     * Flip the un-requested `Autonoma` check to the in-progress "Analyzing" state and stamp
     * the `ready_for_review` activation, for the auto-run-on-ready path that reaches the pipeline without going
     * through the API's `requestAnalysisRun`.
     */
    openMergeGate(input: OpenMergeGateInput): Promise<OpenMergeGateOutput>;
    runImpactAnalysis(input: RunImpactAnalysisInput): Promise<RunImpactAnalysisOutput>;
    runReporter(input: RunReporterInput): Promise<RunReporterOutput>;
    settleAnalysisRun(input: SettleAnalysisRunInput): Promise<SettleAnalysisRunOutput>;
}

/**
 * The Investigator's own write activities: its row-local test edits on the snapshot - a self-heal plan rewrite
 * (`UpdateTest`), the revert of that rewrite when a `plan_mismatch` is kept (`RevertPlan`, no re-run so the failed
 * rewrite is not promoted), and the removal of an irreparable test on an `invalid_test` verdict (`RemoveTest`) - all
 * via the canonical `TestSuiteUpdater` update actions - plus `persistAnalysisClassification`, with which it files each
 * iteration's outcome as it happens. `invalid_test` is the only verdict that removes a test. A separate contract from
 * `AnalysisActivities` (the parent stages); the parent also proxies it to contain a child that crashed, appending a
 * fault classification rather than overwriting what the child wrote.
 */
export interface InvestigatorActivities {
    selfHealAnalysisTest(input: SelfHealAnalysisTestInput): Promise<SelfHealAnalysisTestOutput>;
    revertSelfHealPlan(input: RevertSelfHealPlanInput): Promise<RevertSelfHealPlanOutput>;
    deleteAnalysisTest(input: DeleteAnalysisTestInput): Promise<DeleteAnalysisTestOutput>;
    persistAnalysisClassification(
        input: PersistAnalysisClassificationInput,
    ): Promise<PersistAnalysisClassificationOutput>;
}
