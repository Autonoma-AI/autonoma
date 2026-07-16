import type { AnalysisMode } from "@autonoma/types";

/**
 * The merged analysis pipeline's activities (run on the INVESTIGATION task queue for now - the queue collapse
 * is a cleanup-phase concern). In `shadow` mode Impact Analysis really selects affected tests, the Investigators
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
    /** The Investigator's terminal verdict category. Collapsed to `passed` | `client_bug` in this slice - the
     * full taxonomy (engine_artifact / environment_failure / scenario_issue / delete) lands with the verdict issue. */
    category: string;
    headline: string;
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

/** The activities run by the merged analysis pipeline. */
export interface AnalysisActivities {
    runImpactAnalysis(input: RunImpactAnalysisInput): Promise<RunImpactAnalysisOutput>;
    reconcileAnalysis(input: ReconcileAnalysisInput): Promise<ReconcileAnalysisOutput>;
    finalizeAnalysis(input: FinalizeAnalysisInput): Promise<FinalizeAnalysisOutput>;
}
