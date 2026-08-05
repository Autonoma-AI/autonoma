import type {
    AnalysisClassificationReport,
    AnalysisRunOutcome,
    AnalysisTestOrigin,
    AnalysisVerdict,
    InvestigationRunStep,
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
export interface OpenAnalysisRunInput {
    branchId: string;
    headSha: string;
    /** Fallback base sha (the PR base) used when the branch has no active-snapshot head yet. */
    baseSha?: string;
}

/**
 * `skipped` when the head was already analyzed (a re-delivered trigger, or a redeploy of an unchanged commit):
 * there is no selection to make and no run to settle. A previewkit run still builds for it - the customer asked
 * for a fresh preview of a commit we have already judged.
 */
export type OpenAnalysisRunOutput = { skipped: true } | { skipped: false; snapshotId: string };

/** A serializable verdict, structurally assignable from the classifier's own `RunVerdict`. */
export interface InvestigationEvidence {
    source: string;
    detail: string;
    file?: string;
    lines?: string;
    snippet?: string;
}
export interface InvestigationVerdict {
    category: string;
    isClientBug: boolean;
    ran: boolean;
    confidence: string;
    planFidelity?: string;
    headline: string;
    /** What the app SHOULD have done / what it actually did. */
    expectedBehavior?: string;
    actualBehavior?: string;
    /** The false-positive self-check. Set for a bug / setup failure; absent for a passed run or a harness fault. */
    falsePositiveRisk?: string;
    /** Free-form "what happened" narrative, filled by the coverage faults (engine_artifact / environment_failure
     * / scenario_issue); the app-health categories use expected/actual above instead. */
    whatHappened?: string;
    rootCause?: string;
    remediation?: string;
    suggestedTestUpdate?: string;
    /** The `plan_mismatch` self-heal post-mortem: what the test asserted that was wrong, the rewrite attempted,
     * and why it still failed. Set only for a `plan_mismatch` verdict. */
    planMismatchNote?: string;
    /** The `invalid_test` justification: which impossibility failure mode (nonexistent feature / unexecutable
     * steps / wrong premise / unrecoverable) and the proof. Set only for an `invalid_test` verdict. */
    invalidTestNote?: string;
    /** App problems visible in the video independent of the test's pass/fail; absent if the app looked healthy. */
    observedAppIssues?: string;
    evidence: InvestigationEvidence[];
}

/** One classified run, carried from the classify activity to the Reporter. */
export interface InvestigationTestResult {
    slug: string;
    /** The test's current plan (for rendering the suggested update as a diff). */
    plan: string;
    runSuccess: boolean;
    stepCount: number;
    /** The step-by-step run trace (interaction + status + per-step error) - the run agent's observation log. */
    runSteps?: string[];
    /** The structured trace: per-step frame (s3 key) + click coords, for the inspectable run-trace UI. */
    runTrace?: InvestigationRunStep[];
    verdict?: InvestigationVerdict;
    error?: string;
    videoUrl?: string;
    /** The dead-time-stripped mp4 recording (s3 key), when the engine produced one. Signed on read; backs the
     *  finding page's Optimized/Original toggle. Absent for runs recorded before the optimizer landed. */
    optimizedVideoUrl?: string;
    keyScreenshotUrl?: string;
    /** S3 key of a short GIF clip of the failure (client bugs only). */
    clipUrl?: string;
    /**
     * `s3://` URL of the classifier's persisted LLM conversation for this run (the reasoning behind the verdict),
     * uploaded by the classify activity and signed on read. Best-effort: absent when the upload failed or the run
     * reached no classifier verdict. Threaded onto this run's classification so a wrong verdict can be debugged.
     */
    conversationUrl?: string;
}

export interface ClassifyInvestigationRunInput {
    snapshotId: string;
    slug: string;
    reason: string;
    testGenerationId: string;
    /**
     * Present when this run is a SELF-HEAL RE-RUN: the prior pass's verdict on the original plan. The classifier
     * needs this context - the prior pass concluded the app was healthy and the test itself was wrong, and this
     * run executes the corrected plan - so a still-failing re-run is judged against that conclusion (the test
     * could not be stabilized) instead of being re-investigated from scratch and flakily escalated to a bug.
     */
    priorPass?: {
        category: string;
        headline: string;
        rootCause?: string;
    };
}

/**
 * Everything the diffs worker runs on the DIFFS queue: the run's own stages, the per-test classify, and the
 * Investigator's row-local writes. One contract because one worker implements all of it - the differing timeouts
 * live at the `proxyActivities` call sites, each of which `Pick`s the members it actually calls, so no workflow
 * can reach an activity it has not declared.
 */
export interface AnalysisActivities {
    /**
     * Open the branch's analysis run - its pending snapshot plus the AnalysisJob tracking it - superseding whatever
     * run the branch had in flight. Deliberately URL-free: a previewkit run calls this before its preview exists,
     * and whether one ever will is what the build warrant is about to decide.
     */
    openAnalysisRun(input: OpenAnalysisRunInput): Promise<OpenAnalysisRunOutput>;
    /**
     * Flip the un-requested `Autonoma` check to the in-progress "Analyzing" state and stamp
     * the `ready_for_review` activation, for the auto-run-on-ready path that reaches the pipeline without going
     * through the API's `requestAnalysisRun`.
     */
    openMergeGate(input: OpenMergeGateInput): Promise<OpenMergeGateOutput>;
    runImpactAnalysis(input: RunImpactAnalysisInput): Promise<RunImpactAnalysisOutput>;
    /** One test's run classified into a verdict. The long pole of an Investigator pass - see its proxy's timeout. */
    classifyInvestigationRun(input: ClassifyInvestigationRunInput): Promise<InvestigationTestResult>;
    /**
     * The Investigator's row-local test edits on the snapshot, all via the canonical `TestSuiteUpdater` update
     * actions: a self-heal plan rewrite (`UpdateTest`), the revert of that rewrite when a `plan_mismatch` is kept
     * (`RevertPlan`, no re-run so the failed rewrite is not promoted), and the removal of an irreparable test on an
     * `invalid_test` verdict (`RemoveTest`). `invalid_test` is the only verdict that removes a test.
     */
    selfHealAnalysisTest(input: SelfHealAnalysisTestInput): Promise<SelfHealAnalysisTestOutput>;
    revertSelfHealPlan(input: RevertSelfHealPlanInput): Promise<RevertSelfHealPlanOutput>;
    deleteAnalysisTest(input: DeleteAnalysisTestInput): Promise<DeleteAnalysisTestOutput>;
    /**
     * File one iteration's outcome as it happens. Proxied by the Investigator for its own iterations AND by the
     * fan-out parent, which uses it to contain a child that crashed before filing - appending a fault
     * classification rather than overwriting what the child wrote.
     */
    persistAnalysisClassification(
        input: PersistAnalysisClassificationInput,
    ): Promise<PersistAnalysisClassificationOutput>;
    runReporter(input: RunReporterInput): Promise<RunReporterOutput>;
    settleAnalysisRun(input: SettleAnalysisRunInput): Promise<SettleAnalysisRunOutput>;
}
