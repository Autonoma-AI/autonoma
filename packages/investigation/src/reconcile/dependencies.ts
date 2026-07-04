import type { LanguageModel } from "ai";
import type { CodebaseReader } from "../classify/dependencies";

/** One piece of code/run evidence a finding cited (a subset of the report's evidence shape). */
export interface ReconcilableEvidence {
    source: string;
    detail: string;
    file?: string;
    lines?: string;
    snippet?: string;
}

/**
 * The projection of a finding the reconciliation agent reasons over: the stable id it clusters by, plus the
 * narrative + evidence that reveal the underlying cause. Deliberately excludes run media (video/screenshots) -
 * the agent decides sameness from the diagnosis text and the code, not the recording.
 */
export interface ReconcilableFinding {
    /** The finding's stable per-report id (what merges reference). */
    id: string;
    slug: string;
    category: string;
    confidence?: string;
    headline: string;
    rootCause?: string;
    whatHappened?: string;
    observedAppIssues?: string;
    remediation?: string;
    evidence: ReconcilableEvidence[];
}

/**
 * Everything the reconciliation agent needs, injected so the loop is unit-/eval-testable with fakes and the
 * worker wires the real implementations. The code reach is the SAME `CodebaseReader` the classifier uses (the
 * cloned repo at the PR head); it is optional so the agent still runs findings-only when no clone is available.
 */
export interface ReconcileDeps {
    /** The run's problem findings (passing/errored ones are filtered out upstream - nothing to reconcile there). */
    findings: ReconcilableFinding[];
    /** Optional: when present, the agent can read code / grep / diff to confirm two findings share a cause. */
    codebase?: CodebaseReader;
    model: LanguageModel;
    /** Tool-call budget for the agent's investigation loop. */
    maxSteps: number;
}
