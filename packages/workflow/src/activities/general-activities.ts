/**
 * Activities executed on the "general" task queue.
 * Workers must export an object that `satisfies GeneralActivities` to ensure type safety.
 */

import type {
    GenerationVerdict,
    GenerationVerdictKind,
    HealingReviewLink,
    IssueReport,
    SuspectedCause,
} from "@autonoma/types";

export type { HealingReviewLink, IssueReport, SuspectedCause };

export type HealingSeverity = "critical" | "high" | "medium" | "low";

export type WorkflowArchitecture = "WEB" | "MOBILE";

export interface HealingEvidenceItem {
    type: "screenshot" | "video" | "conversation" | "step_output";
    description: string;
    s3Key?: string;
}

export interface ScenarioUpInput {
    entityId: string;
    scenarioId: string;
    sdkUrlOverride?: string;
}

export interface ScenarioUpOutput {
    scenarioInstanceId: string;
}

export interface ScenarioDownInput {
    scenarioInstanceId: string;
}

export interface ReviewGenerationInput {
    generationId: string;
}

export interface ReviewGenerationOutput {
    status: "completed" | "failed" | "skipped";
    verdict?: GenerationVerdict;
}

export interface NotifyGenerationExitInput {
    testGenerationId: string;
}

export interface MarkGenerationFailedInput {
    testGenerationId: string;
    /** Structured reason the generation failed; persisted to the `failure` column. */
    failure: PrismaJson.GenerationFailure;
}

// Refinement loop activity inputs.

/**
 * Initializes a refinement loop: creates the loop, iter 1 (status=pending),
 * and iter 1's RefinementIterationInput rows, seeded by trigger. Single
 * transaction so iter 1 is fully formed before the workflow continues.
 *
 * Both triggers seed identically from the snapshot's *pending generations* - the
 * system's record of "work the loop must finish before activating the snapshot":
 *  - Onboarding: the planner's pending generations.
 *  - Diffs: a pending generation per affected test (queued by analysis) plus the
 *    new tests the diffs agent authored during analysis.
 * Iter 1's generation pipeline generates + reviews them; a generation passing its
 * review is the definition of "validated".
 */
export interface InitRefinementLoopInput {
    snapshotId: string;
    triggeredBy: "onboarding" | "diffs";
}
export interface InitRefinementLoopOutput {
    loopId: string;
    organizationId: string;
    firstIterationId: string;
    /**
     * Whether the workflow should fire iter 1's generation pipeline. True iff the
     * snapshot has pending generations to generate/review when the loop starts.
     * False when there is nothing to generate.
     */
    runFirstIterationPipeline: boolean;
}

/** Transitions an iteration row to status=running. */
export interface MarkRefinementIterationRunningInput {
    iterationId: string;
}

export interface FinishRefinementIterationInput {
    iterationId: string;
}

export interface FinishErroredRefinementIterationsInput {
    loopId: string;
}

export interface FinishRefinementLoopInput {
    loopId: string;
    status: "converged" | "max_iterations" | "error";
}

export interface FinalizePendingSnapshotInput {
    snapshotId: string;
}

export interface PreparedGeneration {
    testGenerationId: string;
    scenarioId?: string;
    architecture: WorkflowArchitecture;
}

export interface PrepareGenerationQueueInput {
    snapshotId: string;
    organizationId: string;
}
export interface PrepareGenerationQueueOutput {
    /**
     * Generations that have been validated and marked as queued. Empty when
     * there were no pending generations or deployment validation failed (the
     * failed generations are recorded server-side with a user-facing reason).
     */
    generations: PreparedGeneration[];
}

export interface GenerationOutcomeFailure {
    failureKey: string;
    testCaseId: string;
    testCaseSlug: string;
    testCaseName: string;
    planId: string;
    planPrompt: string;
    sourceId: string;
    sourceStatus: string;
    verdict?: GenerationVerdict;
    verdictKind?: GenerationVerdictKind;
    reviewReasoning?: string;
    generationReviewId?: string;
}

/**
 * A failure routed out of the healable buckets because healing cannot fix it -
 * currently only `scenario_setup` infra failures. The loop records these for
 * observability but never feeds them to the healing agent, so an iteration
 * whose only failures are system-blocked converges without churning.
 */
export type SystemBlockedOutcome = GenerationOutcomeFailure;

/**
 * Persisted refinement action with its row id. The healing-actions activity
 * walks a batch of these and applies each one, marking the row applied on success.
 */
export interface PersistedHealingAction {
    refinementActionId: string;
    /**
     * The action payload as the agent emitted it. Discriminator carries the kind.
     * Kept as a typed JSON-shaped union to keep activities loosely coupled to the
     * @autonoma/diffs package.
     */
    action:
        | { kind: "update_plan"; planId: string; testCaseId: string; newPrompt: string; reasoning: string }
        | {
              kind: "report_bug";
              testCaseId: string;
              title: string;
              description: string;
              severity: HealingSeverity;
              evidence: HealingEvidenceItem[];
              reasoning: string;
              suspectedCause: SuspectedCause;
              report?: IssueReport;
              reviewLink: HealingReviewLink;
          }
        | {
              kind: "report_engine_limitation";
              testCaseId: string;
              title: string;
              description: string;
              severity: HealingSeverity;
              evidence: HealingEvidenceItem[];
              reasoning: string;
              reviewLink: HealingReviewLink;
          }
        | {
              kind: "report_unknown_issue";
              testCaseId: string;
              title: string;
              description: string;
              severity: HealingSeverity;
              evidence: HealingEvidenceItem[];
              reasoning: string;
              reviewLink: HealingReviewLink;
          }
        | {
              kind: "report_scenario_unsupported";
              testCaseId: string;
              title: string;
              description: string;
              severity: HealingSeverity;
              evidence: HealingEvidenceItem[];
              reasoning: string;
              reviewLink: HealingReviewLink;
          }
        | {
              kind: "remove_test";
              testCaseId: string;
              reason: string;
              evidence?: HealingEvidenceItem[];
              reviewLink: HealingReviewLink;
          };
}

export interface ApplyHealingActionsInput {
    snapshotId: string;
    organizationId: string;
    actions: PersistedHealingAction[];
    /** The iteration whose healing actions are being applied. */
    currentIterationId: string;
    /** The iteration's number (1-indexed). Used to set iter N+1's `number`. */
    currentIterationNumber: number;
}

/**
 * Output of applyHealingActions. When the actions included any plan-changing
 * kinds (update_plan), the activity also creates iteration N+1 with
 * status=pending and writes its RefinementIterationInput rows. The workflow
 * then fires `runGenerationPipeline` against `nextIterationPlanIds` before
 * advancing into iter N+1's body.
 */
export interface ApplyHealingActionsOutput {
    /** Iter N+1's id if plan-changing actions ran; undefined otherwise. */
    nextIterationId?: string;
    /** Plan ids that iter N+1 will analyze. Empty when nextIterationId is undefined. */
    nextIterationPlanIds: string[];
}

/**
 * Bucketed analysis of an iteration's input plans, derived from the
 * RefinementIterationInput table joined to the latest generation/run per plan.
 */
export interface AnalyzeResultsInput {
    iterationId: string;
}
export interface AnalyzeResultsOutput {
    /** Test case ids whose generation review passed for this iteration. */
    validatedTestCaseIds: string[];
    /** Plans whose generation (or its review) failed for this iteration. */
    failuresAtGeneration: GenerationOutcomeFailure[];
    /**
     * Plans whose generation failed with an un-healable infra failure
     * (`scenario_setup`). Routed out of the healable buckets so the loop ignores
     * them for convergence.
     */
    systemBlocked: SystemBlockedOutcome[];
}

/**
 * Runs the per-batch generation pipeline against whatever is currently pending
 * in the snapshot: queue the pending generations and dispatch batch generation.
 * Each generation's review runs inside the batch, so by the time this returns
 * every generation row is terminal and reviewed. Outcomes land in DB; the next
 * iteration's `analyzeResults` reads them back via the iteration's
 * RefinementIterationInput rows.
 *
 * Pre: the set of pending gens at call time equals the scope this iteration
 * owns. The refinement loop maintains this invariant - init writes iter 1's
 * inputs from the snapshot's pending set, and applyHealingActions's
 * TestSuiteChange.apply calls addJob for exactly the planIds it records as
 * iter N+1's inputs.
 */
export interface RunGenerationPipelineInput {
    snapshotId: string;
    organizationId: string;
    /** Used only to build deterministic child workflow ids; not stored. */
    loopId: string;
    /** Used only to build deterministic child workflow ids; not stored. */
    iterationNumber: number;
}

export interface RunHealingAgentForRefinementInput {
    iterationId: string;
    iteration: number;
    /**
     * The loop's iteration cap (3 for both diffs and onboarding). The agent reads
     * this to detect the final turn and withhold its retry tool (`update_plan`),
     * so the last round triages instead of spawning a dangling iteration N+1.
     */
    maxIterations: number;
    snapshotId: string;
    organizationId: string;
    failuresAtGeneration: GenerationOutcomeFailure[];
}
export interface RunHealingAgentForRefinementOutput {
    persistedActions: PersistedHealingAction[];
    reasoning: string;
}

export interface GeneralActivities {
    scenarioUp(input: ScenarioUpInput): Promise<ScenarioUpOutput>;
    scenarioDown(input: ScenarioDownInput): Promise<void>;
    markGenerationFailed(input: MarkGenerationFailedInput): Promise<void>;
    notifyGenerationExit(input: NotifyGenerationExitInput): Promise<void>;
    applyHealingActions(input: ApplyHealingActionsInput): Promise<ApplyHealingActionsOutput>;
    initRefinementLoop(input: InitRefinementLoopInput): Promise<InitRefinementLoopOutput>;
    markRefinementIterationRunning(input: MarkRefinementIterationRunningInput): Promise<void>;
    analyzeResults(input: AnalyzeResultsInput): Promise<AnalyzeResultsOutput>;
    finishRefinementIteration(input: FinishRefinementIterationInput): Promise<void>;
    finishErroredRefinementIterations(input: FinishErroredRefinementIterationsInput): Promise<void>;
    finishRefinementLoop(input: FinishRefinementLoopInput): Promise<void>;
    prepareGenerationQueue(input: PrepareGenerationQueueInput): Promise<PrepareGenerationQueueOutput>;
    finalizePendingSnapshot(input: FinalizePendingSnapshotInput): Promise<void>;
}
