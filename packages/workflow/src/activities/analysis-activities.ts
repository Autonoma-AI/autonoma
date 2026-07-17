import type { AnalysisMode, AnalysisTestOrigin, AnalysisVerdict } from "@autonoma/types";

/**
 * The merged analysis pipeline's activities (run on the DIFFS task queue - the pipeline is re-homed into the
 * diffs worker; investigation is frozen). In `shadow` mode Impact Analysis really selects affected tests, the Investigators
 * really run + classify them, and the Reconciler persists the verdict + findings to the shadow store; nothing
 * user-facing is written and the twin is never promoted. Authoritative promotion + Bug/Issue filing stay guarded
 * behind `mode === "authoritative"` and remain dormant until the cutover ships.
 */

/** One test the Impact Analysis stage selects for an Investigator to run + classify. */
export interface AnalysisInvestigationTarget {
    slug: string;
    /** The shadow generation the Investigator runs (created up front by the selection). */
    testGenerationId: string;
    /** The scenario to provision before the run, when the test pins one. */
    scenarioId?: string;
    /** Why this test was selected - fed to the classifier as context. */
    reason: string;
    /** Whether this test pre-existed (affected) or was authored this run (proposed) - set at materialization. */
    origin: AnalysisTestOrigin;
}

export interface RunImpactAnalysisInput {
    /** The detached twin snapshot the pipeline operates on (never a branch pointer). */
    snapshotId: string;
    mode: AnalysisMode;
}

export interface RunImpactAnalysisOutput {
    /** The diff-affected tests to fan out one Investigator over each. */
    targets: AnalysisInvestigationTarget[];
}

/** A candidate finding an Investigator emits. The Investigator never files - the Reconciler owns that write. */
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
}

/** The deployed (authoritative diffs) agent's outcome, read for the shadow-vs-diffs comparison. */
export interface AnalysisDeployedComparison {
    /** Whether a diffs job was found for the twin's head SHA. */
    found: boolean;
    jobStatus?: string;
    /** How many tests the deployed agent flagged as affected (0 when not found). */
    deployedTestCount: number;
}

export interface ReconcileAnalysisInput {
    snapshotId: string;
    mode: AnalysisMode;
    candidates: AnalysisCandidateFinding[];
}

export interface ReconcileAnalysisOutput {
    /** The shadow app-health verdict for the PR: `client_bug` if any finding is a client bug, else `passed`. */
    verdict: string;
    /** How many tests were investigated (raw candidate findings, before dedup). */
    testCount: number;
    /** How many distinct findings remained after holistic dedup (candidates sharing a cause are unioned into one). */
    findingCount: number;
    /** How many of the deduped findings are client bugs. */
    clientBugCount: number;
    // The two-plane + narration outputs below are optional because the frozen investigation worker shares this
    // contract and emits only the fields above; the diffs analysis pipeline always populates them.
    /** How many deduped findings fall on the coverage-confidence plane (never bugs, never blocking). */
    coverageFindingCount?: number;
    /** Proposed tests the run could not establish (delete findings with `origin: proposed`). */
    unestablishedProposedCount?: number;
    /** Pre-existing tests removed as obsolete (delete findings with `origin: pre_existing`). */
    obsoleteRemovedCount?: number;
    /** Whether the constrained narration was produced (a narration failure degrades to absent). */
    narrated?: boolean;
    /** The DeployedComparison produced against the authoritative diffs output. */
    comparison: AnalysisDeployedComparison;
    /** How many findings were filed as bugs - always 0 in shadow mode (nothing is filed). */
    filedCount: number;
}

export interface FinalizeAnalysisInput {
    snapshotId: string;
    mode: AnalysisMode;
}

export interface FinalizeAnalysisOutput {
    /** Whether the twin snapshot was promoted - always false in shadow mode. */
    promoted: boolean;
}

export interface SelfHealAnalysisTestInput {
    /** The detached twin snapshot the test's rows live on. */
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
    /** The detached twin snapshot the test's assignment lives on. */
    snapshotId: string;
    /** The test whose assignment to remove from the twin. */
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

/** The parent stages of the merged analysis pipeline (Impact Analysis, Reconciler, finalize). */
export interface AnalysisActivities {
    runImpactAnalysis(input: RunImpactAnalysisInput): Promise<RunImpactAnalysisOutput>;
    reconcileAnalysis(input: ReconcileAnalysisInput): Promise<ReconcileAnalysisOutput>;
    finalizeAnalysis(input: FinalizeAnalysisInput): Promise<FinalizeAnalysisOutput>;
}

/**
 * The Investigator's own row-local write activities on the detached snapshot: a self-heal plan rewrite
 * (`UpdateTest`) and the eager `delete` self-delete (`RemoveTest`), both via the canonical `TestSuiteUpdater`
 * update actions. A separate contract from `AnalysisActivities` (the parent stages): only the re-homed diffs
 * worker implements these, so they stay off the contract the frozen investigation worker still satisfies.
 */
export interface InvestigatorActivities {
    selfHealAnalysisTest(input: SelfHealAnalysisTestInput): Promise<SelfHealAnalysisTestOutput>;
    deleteAnalysisTest(input: DeleteAnalysisTestInput): Promise<DeleteAnalysisTestOutput>;
}
