import type { AnalysisMode } from "@autonoma/types";

/**
 * The merged analysis pipeline's activities, run on the INVESTIGATION task queue (reusing the shadow
 * investigation worker). Every stage is currently a skeleton stub: it logs, guards production writes behind
 * `mode === "authoritative"`, and returns placeholder data so a shadow run completes end-to-end without
 * touching production.
 */

/** One test the Impact Analysis stage selects for an Investigator to run + classify. */
export interface AnalysisInvestigationTarget {
    slug: string;
    /** The shadow generation the Investigator runs. Absent while Impact Analysis is a stub (no targets). */
    testGenerationId?: string;
}

export interface RunImpactAnalysisInput {
    /** The detached twin snapshot the pipeline operates on (never a branch pointer). */
    snapshotId: string;
    mode: AnalysisMode;
}

export interface RunImpactAnalysisOutput {
    /** The tests to fan out Investigators over. Empty while Impact Analysis is a stub. */
    targets: AnalysisInvestigationTarget[];
}

/** A candidate finding an Investigator emits. The Investigator never files - the Reconciler owns that write. */
export interface AnalysisCandidateFinding {
    slug: string;
    /** The Investigator's terminal verdict category (placeholder while the Investigator is a stub). */
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
    /** The DeployedComparison placeholder produced against the authoritative diffs output. */
    comparison: AnalysisDeployedComparison;
    /** How many candidate findings were filed as bugs - always 0 in shadow mode (nothing is filed). */
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
