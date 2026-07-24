import type { AnalysisFindingReport, AnalysisTestOrigin, AnalysisVerdict } from "@autonoma/types";

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
    /** The generation the Investigator runs (created up front by the selection). */
    testGenerationId: string;
    /** The scenario to provision before the run, when the test pins one. */
    scenarioId?: string;
    /** Why this test was selected - fed to the classifier as context. */
    reason: string;
    /** Whether this test pre-existed (affected) or was authored this run (proposed) - set at materialization. */
    origin: AnalysisTestOrigin;
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
 * A finding an Investigator produces for its one test. The Investigator persists it itself (via
 * `persistAnalysisFinding`) when its self-heal loop terminates and returns it for the parent's logging; the parent
 * files a contained one only for a crashed/timed-out child.
 */
export interface AnalysisCandidateFinding {
    slug: string;
    /** The Investigator's terminal verdict (the full two-plane taxonomy). Never `test_is_wrong` - that is a
     * transient loop-routing signal that resolves to a re-run or, when exhausted, to `delete`. */
    category: AnalysisVerdict;
    headline: string;
    /**
     * Whether the Investigator rewrote this test's plan during its run (a self-heal re-run was applied). This is
     * the fidelity signal - it replaces the classifier's PlanFidelity axis: a finding whose plan was edited was
     * reached against a corrected test, one whose plan was not is the test as authored.
     */
    planEdited: boolean;
    /**
     * Whether the test pre-existed (affected) or was authored this run (proposed). The data tag that lets a
     * `delete` finding be read apart - an obsolete pre-existing test vs a proposed test that could not be
     * established - without a separate verdict.
     */
    origin: AnalysisTestOrigin;
    /** Why Impact Analysis selected this test - the per-test selection provenance the Reporter reads as context. */
    selectionReason?: string;
    /** A brief note on what the Investigator self-healed, present only when `planEdited` (retry-context color). */
    selfHealNote?: string;
    /**
     * The classifier's full rich output for this run (narrative, evidence, run-trace frames, media keys) - what
     * the pipeline used to discard. Persisted onto the finding's `AnalysisFinding` row (the store that renders it -
     * a `client_bug` carries its evidence here, not in any Bug/Issue). Absent for a contained scenario/classify
     * fault or a crashed Investigator, which never reached a classifier verdict.
     */
    report?: AnalysisFindingReport;
}

export interface PersistAnalysisFindingInput {
    /** The snapshot the run operates on (the finding's report/job share this PK). */
    snapshotId: string;
    /** The finding to persist - the Investigator's own, or a parent-authored containment finding. */
    finding: AnalysisCandidateFinding;
}

export interface PersistAnalysisFindingOutput {
    /** The stable per-report routing id the finding was stored under (its slug). */
    findingKey: string;
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

export interface FinalizeAnalysisInput {
    snapshotId: string;
    /**
     * When present, the run FAILED with this reason: finalize marks the AnalysisJob `failed` and does NOT
     * promote. Absent on the happy path, where finalize promotes the snapshot and marks the job `completed`.
     * Mirrors `finalizeDiffs`'s both-terminal shape.
     */
    failureReason?: string;
}

export interface FinalizeAnalysisOutput {
    /** Whether the snapshot was promoted - false on the failure path. */
    promoted: boolean;
}

export interface PostAnalysisPrCommentInput {
    /** The branch's real pending snapshot the run reconciled - the comment reads its persisted AnalysisReport. */
    snapshotId: string;
}

export interface PostAnalysisPrCommentOutput {
    /** "posted" (new comment) | "updated" (edited in place) | "skipped" (flag off, no PR, or no report). */
    status: "posted" | "updated" | "skipped";
    /** The PR comment id when one was posted or updated; absent when skipped. */
    commentId?: string;
}

export interface ApplyMergeGateVerdictInput {
    /** The branch's real pending snapshot the run reconciled - the check reads its persisted AnalysisReport verdict. */
    snapshotId: string;
}

export interface ApplyMergeGateVerdictOutput {
    /** "posted" (the `Autonoma` check conclusion was set) | "skipped" (gate off for the org, or no PR). */
    status: "posted" | "skipped";
    /** The conclusion set on the check when posted; absent when skipped. */
    conclusion?: "success" | "failure" | "neutral";
}

export interface SelfHealAnalysisTestInput {
    /** The snapshot the test's rows live on. */
    snapshotId: string;
    /** The test whose plan to rewrite (its own (snapshot, testCase) rows). */
    slug: string;
    /** The classifier's COMPLETE revised plan to author onto the test. */
    plan: string;
}

export interface SelfHealAnalysisTestOutput {
    /** A fresh pending generation to re-run + re-classify, or undefined when one could not be prepared. */
    testGenerationId?: string;
    /** The scenario the rewritten plan pins (preserved from the test's current plan), when it pins one. */
    scenarioId?: string;
    /** Why no generation was prepared, when `testGenerationId` is absent (e.g. the slug has no assignment). */
    skippedReason?: string;
}

export interface DeleteAnalysisTestInput {
    /** The snapshot the test's assignment lives on. */
    snapshotId: string;
    /** The test whose assignment to remove from the snapshot. */
    slug: string;
    /**
     * Whether the test pre-existed or was proposed this run. `pre_existing` removes only this snapshot's
     * assignment (the global TestCase is a real suite member); `proposed` removes the whole TestCase (it was
     * authored this run and would otherwise leak as an orphaned catalog row).
     */
    origin: AnalysisTestOrigin;
}

export interface DeleteAnalysisTestOutput {
    /** Whether an assignment was actually removed (false when the slug had no assignment on the snapshot). */
    deleted: boolean;
    /** Why nothing was removed, when `deleted` is false. */
    reason?: string;
}

/**
 * The parent stages of the merged analysis pipeline (Impact Analysis, Reporter, finalize) plus the terminal
 * PR-comment step. `postAnalysisPrComment` runs after finalize on the happy path and is fully contained: it
 * reads the persisted AnalysisReport and posts/updates a single `analysis`-kind PR comment, gated OFF by default.
 */
export interface AnalysisActivities {
    runImpactAnalysis(input: RunImpactAnalysisInput): Promise<RunImpactAnalysisOutput>;
    runReporter(input: RunReporterInput): Promise<RunReporterOutput>;
    finalizeAnalysis(input: FinalizeAnalysisInput): Promise<FinalizeAnalysisOutput>;
    postAnalysisPrComment(input: PostAnalysisPrCommentInput): Promise<PostAnalysisPrCommentOutput>;
    /**
     * Merge-gate finalize step: map the persisted `AnalysisReport.verdict` to the `Autonoma` check conclusion and
     * post/update the check. Runs after finalize on the happy path, fully contained like postAnalysisPrComment, and
     * gated OFF by default (per-org `mergeGateEnabled` + the global MERGE_GATE_ENABLED switch).
     */
    applyMergeGateVerdict(input: ApplyMergeGateVerdictInput): Promise<ApplyMergeGateVerdictOutput>;
}

/**
 * The Investigator's own write activities: its row-local test edits on the snapshot - a self-heal plan rewrite
 * (`UpdateTest`) and the eager `delete` self-delete (`RemoveTest`), both via the canonical `TestSuiteUpdater`
 * update actions - plus `persistAnalysisFinding`, the idempotent upsert with which each Investigator files its own
 * finding when its loop terminates. A separate contract from `AnalysisActivities` (the parent stages); the parent
 * also proxies it to file a containment finding for a child that crashed before it could persist its own.
 */
export interface InvestigatorActivities {
    selfHealAnalysisTest(input: SelfHealAnalysisTestInput): Promise<SelfHealAnalysisTestOutput>;
    deleteAnalysisTest(input: DeleteAnalysisTestInput): Promise<DeleteAnalysisTestOutput>;
    persistAnalysisFinding(input: PersistAnalysisFindingInput): Promise<PersistAnalysisFindingOutput>;
}
