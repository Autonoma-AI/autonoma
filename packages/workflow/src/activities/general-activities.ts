/**
 * Activities executed on the "general" task queue.
 * Workers must export an object that `satisfies GeneralActivities` to ensure type safety.
 */

import type {
    GenerationVerdict,
    GenerationVerdictKind,
    HealingReviewLink,
    ReplayVerdict,
    ReplayVerdictKind,
} from "@autonoma/types";

export type { HealingReviewLink };

export type HealingSeverity = "critical" | "high" | "medium" | "low";

export type WorkflowArchitecture = "WEB" | "MOBILE";

export interface HealingEvidenceItem {
    type: "screenshot" | "video" | "conversation" | "step_output";
    description: string;
    s3Key?: string;
}

export interface ScenarioUpInput {
    scenarioJobType: string;
    entityId: string;
    scenarioId: string;
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

export interface ReviewReplayInput {
    runId: string;
}

export interface ReviewReplayOutput {
    status: "completed" | "failed" | "skipped";
    verdict?: ReplayVerdict;
}

export interface AssignGenerationResultsInput {
    snapshotId: string;
    generationIds: string[];
}

export interface NotifyGenerationExitInput {
    testGenerationId: string;
}

export interface MarkGenerationFailedInput {
    testGenerationId: string;
    /** Structured reason the generation failed; persisted to the `failure` column. */
    failure: PrismaJson.GenerationFailure;
}

export interface MarkRunFailedInput {
    runId: string;
    /** Structured reason the run failed; persisted to the `failure` column. */
    failure: PrismaJson.RunFailure;
}

// Refinement loop activity inputs.

/**
 * Initializes a refinement loop: creates the loop, iter 1 (status=pending),
 * and the iter-1 RefinementIterationInput rows derived from the snapshot's
 * pending generations. The "pending" status of a generation is the system's
 * record of "this is work the loop must finish before activating the snapshot",
 * so the loop's iter-1 scope is exactly that set. Single transaction so iter 1
 * is fully formed before the workflow continues.
 */
export interface InitRefinementLoopInput {
    snapshotId: string;
    triggeredBy: "onboarding" | "diffs";
}
export interface InitRefinementLoopOutput {
    loopId: string;
    organizationId: string;
    firstIterationId: string;
    /** Whether iter 1 has any plans to fire. Empty -> loop converges immediately. */
    hasPendingWork: boolean;
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
    bucket: "failed_at_generation";
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
export interface GenerationOutcomeSuccess {
    bucket: "success";
    generationId: string;
    architecture: WorkflowArchitecture;
    scenarioId?: string;
}
export type GenerationOutcome = GenerationOutcomeFailure | GenerationOutcomeSuccess;

export interface CreatedRun {
    runId: string;
    architecture: WorkflowArchitecture;
    scenarioId?: string;
}

/**
 * Given a set of completed generations, the activity reads each gen's status
 * and review verdict, and creates a Run for each that passed. Failures are
 * dropped on the floor - the next iteration's `analyzeResults` reads them
 * from DB via the iteration's RefinementIterationInput rows.
 */
export interface PrepareRunsForGenerationsInput {
    generationIds: string[];
}
export interface PrepareRunsForGenerationsOutput {
    /** Run records created for the gens that passed gen-review, ready for replay. */
    runs: CreatedRun[];
}

export interface RunOutcomeFailure {
    bucket: "failed_at_replay";
    failureKey: string;
    testCaseId: string;
    testCaseSlug: string;
    testCaseName: string;
    planId: string;
    planPrompt: string;
    sourceId: string;
    sourceStatus: string;
    verdict?: ReplayVerdict;
    verdictKind?: ReplayVerdictKind;
    reviewReasoning?: string;
    runReviewId?: string;
}
export interface RunOutcomeSuccess {
    bucket: "validated";
    runId: string;
    testCaseId: string;
}
export type RunOutcome = RunOutcomeFailure | RunOutcomeSuccess;

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
              kind: "add_test";
              folderId: string;
              name: string;
              instruction: string;
              scenarioId?: string;
              reasoning: string;
          }
        | {
              kind: "report_bug";
              testCaseId: string;
              title: string;
              description: string;
              severity: HealingSeverity;
              evidence: HealingEvidenceItem[];
              reasoning: string;
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
        | { kind: "remove_test"; testCaseId: string; reason: string };
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
 * kinds (update_plan or add_test), the activity also creates iteration N+1 with
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
    /** Test case ids whose run completed with status=success. */
    validatedTestCaseIds: string[];
    /** Plans whose generation (or its review) failed for this iteration. */
    failuresAtGeneration: GenerationOutcomeFailure[];
    /** Plans whose generation succeeded but whose run (or its review) failed. */
    failuresAtReplay: RunOutcomeFailure[];
}

/**
 * Runs the full per-batch generation pipeline against whatever is currently
 * pending in the snapshot: queue them, dispatch batch generation, create runs
 * for successful gens, fire replays. Outcomes land in DB; the next iteration's
 * `analyzeResults` reads them back via the iteration's RefinementIterationInput
 * rows.
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
    snapshotId: string;
    organizationId: string;
    failuresAtGeneration: GenerationOutcomeFailure[];
    failuresAtReplay: RunOutcomeFailure[];
}
export interface RunHealingAgentForRefinementOutput {
    persistedActions: PersistedHealingAction[];
    reasoning: string;
}

export interface GeneralActivities {
    scenarioUp(input: ScenarioUpInput): Promise<ScenarioUpOutput>;
    scenarioDown(input: ScenarioDownInput): Promise<void>;
    assignGenerationResults(input: AssignGenerationResultsInput): Promise<void>;
    markGenerationFailed(input: MarkGenerationFailedInput): Promise<void>;
    markRunFailed(input: MarkRunFailedInput): Promise<void>;
    notifyGenerationExit(input: NotifyGenerationExitInput): Promise<void>;
    applyHealingActions(input: ApplyHealingActionsInput): Promise<ApplyHealingActionsOutput>;
    initRefinementLoop(input: InitRefinementLoopInput): Promise<InitRefinementLoopOutput>;
    markRefinementIterationRunning(input: MarkRefinementIterationRunningInput): Promise<void>;
    analyzeResults(input: AnalyzeResultsInput): Promise<AnalyzeResultsOutput>;
    finishRefinementIteration(input: FinishRefinementIterationInput): Promise<void>;
    finishErroredRefinementIterations(input: FinishErroredRefinementIterationsInput): Promise<void>;
    finishRefinementLoop(input: FinishRefinementLoopInput): Promise<void>;
    prepareGenerationQueue(input: PrepareGenerationQueueInput): Promise<PrepareGenerationQueueOutput>;
    prepareRunsForGenerations(input: PrepareRunsForGenerationsInput): Promise<PrepareRunsForGenerationsOutput>;
    finalizePendingSnapshot(input: FinalizePendingSnapshotInput): Promise<void>;
}
