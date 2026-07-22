import type { InvestigationRunStep } from "@autonoma/types";
import type { WorkflowArchitecture } from "../types";

/** A shadow test the investigation will run + classify (one shadow TestGeneration already created for it). */
export interface InvestigationSelectedTest {
    slug: string;
    reason: string;
    testGenerationId: string;
    scenarioId?: string;
    architecture: WorkflowArchitecture;
}

export interface SelectInvestigationTestsInput {
    snapshotId: string;
}

export interface AssertSnapshotPendingInput {
    snapshotId: string;
}

/** A NEW test the agent proposes for brand-new functionality (a full E2E plan, following the guardrails). */
export interface SuggestedNewTest {
    name: string;
    /** A one-line falsifiable behavioral claim - the test case's immutable description when persisted. */
    description: string;
    instruction: string;
    reasoning: string;
    /** Validation outcome once the proposed test has been run (Objective 2c); absent until then. */
    validation?: TestValidationResult;
}

/** An existing test the agent recommends quarantining because the PR removed the functionality it covers. */
export interface QuarantineRecommendation {
    slug: string;
    reason: string;
}

/** The outcome of running a proposed/modified plan through the validate->edit->retry loop. */
export interface TestValidationResult {
    passed: boolean;
    iterations: number;
    /** The final plan after any edits (the version that passed, or the last attempt). */
    finalPlan: string;
    /** Why it could not be made to pass, if it didn't. */
    failureReason?: string;
}

export interface SelectInvestigationTestsOutput {
    appSlug: string;
    prNumber: number;
    tests: InvestigationSelectedTest[];
    suggested: SuggestedNewTest[];
    quarantine: QuarantineRecommendation[];
    /** Whether this org has opted into the agent ACTING (recipe/suite edits, client PR comments). */
    autofixEnabled: boolean;
}

/** A serializable verdict (RunVerdict from @autonoma/investigation is structurally assignable to this). */
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
    falsePositiveRisk: string;
    whatHappened: string;
    rootCause: string;
    remediation: string;
    suggestedTestUpdate?: string;
    /** App problems visible in the video independent of the test's pass/fail; absent if the app looked healthy. */
    observedAppIssues?: string;
    evidence: InvestigationEvidence[];
}

/**
 * The scenario-repair diagnoser's routing for a scenario failure (a serializable mirror of
 * @autonoma/investigation's ScenarioDiagnosis). Observe-only in this slice: it says HOW a scenario failure
 * should be repaired (fix the test / edit the recipe / escalate a client-factory change / not a data problem),
 * so the report and PR comment can surface it - nothing acts on it yet.
 */
export interface InvestigationScenarioDiagnosis {
    route: "fix_test" | "recipe_only" | "recipe_and_sdk" | "unknown";
    confidence: string;
    reasoning: string;
    /** The scoped test edit to make (route=fix_test). */
    testFix?: string;
    /** The recipe `create`-graph change to make (route=recipe_only | recipe_and_sdk). */
    recipeChange?: string;
    /** The client-factory change to request from the client's coding agent (route=recipe_and_sdk). */
    factoryIssue?: string;
    /**
     * The concrete candidate recipe `create` graph the agent WOULD activate (route=recipe_only/recipe_and_sdk),
     * as a JSON string. Computed for every org (dry-run); only written when autofix is enabled. Absent if the
     * edit could not be produced.
     */
    proposedRecipeCreateGraph?: string;
    /** One-sentence summary of the proposed recipe edit (accompanies proposedRecipeCreateGraph). */
    proposedRecipeSummary?: string;
    /**
     * Whether the agent actually WROTE the repair (activated the candidate recipe). Only set for autofix-enabled
     * orgs after the candidate passed validation on the twin; absent for dry-run orgs.
     */
    applied?: boolean;
    /** What the write pass did (activated after twin validation / validation failed / nothing to validate). */
    appliedNote?: string;
    /**
     * The recipe-repair AGENT's give-up handoff (autofix orgs): a self-contained account of what it tried and why
     * it could not produce a factory-accepted recipe, for a human or coding agent to pick up. Absent when the agent
     * produced a validated candidate or was never run (dry-run orgs).
     */
    repairHandoff?: string;
}

/** One classified shadow run, carried from the classify activity to the report activity. */
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
    finalScreenshotUrl?: string;
    /** S3 key of a short GIF clip of the failure (client bugs only), embedded in the investigation PR comment. */
    clipUrl?: string;
    /**
     * `s3://` URL of the classifier's persisted LLM conversation for this run (the reasoning behind the verdict),
     * uploaded by the classify activity and signed on read. Best-effort: absent when the upload failed or the run
     * reached no classifier verdict. Threaded onto the finding row so a wrong verdict can be debugged.
     */
    classificationConversationUrl?: string;
    /** Validation outcome if the suggested modification was run through the validate->edit->retry loop. */
    modificationValidation?: TestValidationResult;
    /** How a scenario failure should be repaired (attached by the diagnose pass for scenario_issue results). */
    scenarioDiagnosis?: InvestigationScenarioDiagnosis;
}

export interface DiagnoseInvestigationScenarioInput {
    snapshotId: string;
    slug: string;
    /** The failure to diagnose: the scenario-up SDK error, or the classifier's account of the data mismatch. */
    failureDetail: string;
    /** What the run observed on-screen (for post-seed data mismatches); absent for provisioning failures. */
    runObservation?: string;
}

// --- Recipe-repair AGENT (autofix orgs). A heavier, tool-using pass than the diagnoser's one-shot proposal: it
// reads the client's factory code + DB schema, queries the live backend to see what already exists, validates
// candidate graphs locally, and dry-run-seeds them against the real factory before returning one - or gives up
// with a handoff. The workflow then stages the returned candidate on the twin (the authoritative rerun gate).

/** A recipe the agent already tried and how the REAL test failed with it on the twin (fed back for the next try). */
export interface RecipeRepairAttempt {
    /** The `create` graph that was staged (JSON string). */
    createGraphJson: string;
    /** How the test still failed on the twin with that recipe (the run's account) - what the next try must beat. */
    failureDetail: string;
}

export interface ProposeRecipeRepairInput {
    snapshotId: string;
    slug: string;
    /** The recipe change the diagnoser said is needed (a hint the agent verifies before trusting). */
    recipeChange: string;
    /** The failure being repaired (the SDK error, or the classifier's account of the data mismatch). */
    failureDetail: string;
    /**
     * Recipes tried on earlier outer-loop passes that SEEDED but did not make the test pass on the twin. The agent
     * must produce a DIFFERENT graph (a dry-run seed-ok is not enough - these already seeded and still failed).
     * Empty/absent on the first pass.
     */
    priorAttempts?: RecipeRepairAttempt[];
}

export interface ProposeRecipeRepairOutput {
    route: "fix_test" | "recipe_only" | "recipe_and_sdk" | "unknown";
    confidence: string;
    reasoning: string;
    /** The COMPLETE new `create` graph (JSON string), present + schema-valid iff the agent produced a candidate. */
    createGraphJson?: string;
    /** One-sentence summary of what the candidate recipe change does (accompanies createGraphJson). */
    summary?: string;
    /** The client-factory limitation to fix (route=recipe_and_sdk), for the client's coding agent. */
    factoryIssue?: string;
    /** Give-up / escalation: a self-contained account of what was tried + why it failed, for a human/agent. */
    handoff?: string;
    /** True when the dry-run-seed capability was wired for this run (the SDK key was present). */
    dryRunAvailable: boolean;
}

export interface StageRecipeCandidateInput {
    snapshotId: string;
    slug: string;
    /** The candidate `create` graph (JSON string) to seed on the twin for validation. */
    createGraphJson: string;
}
export interface StageRecipeCandidateOutput {
    staged: boolean;
    /** The shadow generation to re-seed + re-run with the candidate (present when staged). */
    testGenerationId?: string;
    /** The scenario the candidate belongs to (present when staged). */
    scenarioId?: string;
    /** The pre-stage `create` graph (JSON string), to restore via revertTwinRecipe if validation fails. */
    previousCreateGraphJson?: string;
}

export interface RevertTwinRecipeInput {
    snapshotId: string;
    scenarioId: string;
    /** The previous `create` graph (JSON string) to restore onto the twin recipe version. */
    createGraphJson: string;
}
export interface RevertTwinRecipeOutput {
    reverted: boolean;
}

export interface ClassifyInvestigationRunInput {
    snapshotId: string;
    slug: string;
    reason: string;
    testGenerationId: string;
}

// --- Validate->edit->retry loop (Objective 2c). Each iteration creates a shadow generation for a candidate
// plan, the workflow runs it on the web worker, then checks the outcome and (if failed) gets a revised plan.

export interface CreateValidationGenerationInput {
    snapshotId: string;
    /** The candidate plan to validate this iteration. */
    plan: string;
    /** The existing test being MODIFIED (a dangling draft plan is attached to it). Absent for a NEW test. */
    baseSlug?: string;
}

export interface CreateValidationGenerationOutput {
    /** A shadow generation to run + classify, or undefined if one couldn't be prepared. */
    testGenerationId?: string;
    scenarioId?: string;
    /** The slug to classify the run under (the existing slug for a modification). */
    slug?: string;
    /** Why no generation was prepared (e.g. new-test validation needs the shadow-test marker). */
    skippedReason?: string;
}

/**
 * One merge the reconciliation agent proposed: several findings that describe the SAME underlying issue,
 * collapsed into the canonical one with a combined narrative. Structural mirror of the package's `FindingMerge`.
 */
export interface InvestigationFindingMerge {
    /** The finding ids (>= 2) that share one underlying cause. */
    memberIds: string[];
    /** The member kept as the base (its run + category anchor the merged finding). */
    canonicalId: string;
    /** The combined headline for the merged issue. */
    headline: string;
    /** The combined root cause (drawing on every member). */
    rootCause: string;
    /** The combined remediation, if the agent gave one. */
    remediation?: string;
    /** One sentence on why these are the same issue (audit log). */
    reason: string;
}

export interface ReconcileInvestigationFindingsInput {
    snapshotId: string;
    results: InvestigationTestResult[];
}

export interface ReconcileInvestigationFindingsOutput {
    merges: InvestigationFindingMerge[];
}

export interface WriteInvestigationReportInput {
    snapshotId: string;
    results: InvestigationTestResult[];
    suggested: SuggestedNewTest[];
    /** The reconciliation agent's merges, applied to collapse same-issue findings before the report is persisted. */
    reconciliation?: ReconcileInvestigationFindingsOutput;
}

export interface WriteInvestigationReportOutput {
    testCount: number;
    clientBugCount: number;
}

/** Coarse, de-escalated lifecycle stages surfaced while an investigation runs (the PR entry point shows these). */
export type InvestigationProgressStage = "selecting" | "running" | "reporting";

export interface MarkInvestigationProgressInput {
    /** The investigation twin snapshot the report is keyed to. */
    snapshotId: string;
    status: "running" | "failed";
    /** The current coarse stage while running; omitted (cleared) on a terminal failure. */
    stage?: InvestigationProgressStage;
}

export interface PostInvestigationPrCommentInput {
    snapshotId: string;
    results: InvestigationTestResult[];
    suggested: SuggestedNewTest[];
}

export interface PostInvestigationPrCommentOutput {
    /** "posted" (new comment) | "updated" (edited in place) | "skipped" (flag off, or snapshot has no PR). */
    status: "posted" | "updated" | "skipped";
    /** The PR comment id when one was posted or updated; absent when skipped. */
    commentId?: string;
}

// --- Persist add/modify edits onto the investigation snapshot (a proposed suite the merge-with-main step
// later reconciles into main). Persist-only: no generations are queued here.

/** An existing test to repoint to a revised plan on the investigation snapshot. */
export interface InvestigationTestModification {
    slug: string;
    plan: string;
}

/** A brand-new test to add to the investigation snapshot. */
export interface InvestigationNewTest {
    name: string;
    description: string;
    plan: string;
}

export interface PersistInvestigationEditsInput {
    snapshotId: string;
    modifications: InvestigationTestModification[];
    newTests: InvestigationNewTest[];
    /**
     * Slugs of tests to delete from the twin (the PR removed the feature they covered). Gated: the caller passes
     * these only for orgs opted into the agent acting. Just the slugs - the removal rationale is surfaced in the
     * report from the selector's `quarantine` output, not threaded through the write path.
     */
    removals: string[];
}

export interface PersistInvestigationEditsOutput {
    /** How many edits were written (0 when nothing applied). */
    persistedCount: number;
    /** Edits that could not be applied, with reasons (never thrown). */
    skipped: { kind: string; ref: string; reason: string }[];
}

// --- Merge-with-main: after a PR merges, reconcile the branch twin's proposed edits into main's current
// suite (which other merges may have moved) and apply the accepted ones onto a detached main-proposal
// snapshot. Shadow-safe: never touches the real (diffs) main suite.

export interface MergeInvestigationEditsInput {
    /** The branch's investigation twin snapshot (holds the proposed edits). */
    twinSnapshotId: string;
    /** Main's current active snapshot - the suite to reconcile into. */
    mainSnapshotId: string;
    /** The main branch, whose active suite the proposal snapshot is cloned from. */
    mainBranchId: string;
    organizationId: string;
}

/** One reconciliation decision, carried out to the report/PR comment. */
export interface InvestigationMergeDecision {
    kind: string;
    ref: string;
    action: string;
    reason: string;
}

/** One reconciled scenario-recipe decision, surfaced for the merge report. */
export interface InvestigationRecipeMergeDecision {
    scenarioId: string;
    action: string;
    reason: string;
}

export interface MergeInvestigationEditsOutput {
    /** The detached main-proposal snapshot the accepted edits landed on, or undefined when nothing was applied. */
    mainProposalSnapshotId?: string;
    appliedCount: number;
    skippedCount: number;
    /** How many recipe decisions were written onto the proposal snapshot's recipe versions. */
    recipeAppliedCount: number;
    /** How many recipe decisions were dropped (skip, or no recipe version on the proposal). */
    recipeSkippedCount: number;
    decisions: InvestigationMergeDecision[];
    recipeDecisions: InvestigationRecipeMergeDecision[];
}

/** The activities run by the investigation worker (the INVESTIGATION task queue). */
export interface InvestigationActivities {
    assertSnapshotPending(input: AssertSnapshotPendingInput): Promise<void>;
    selectInvestigationTests(input: SelectInvestigationTestsInput): Promise<SelectInvestigationTestsOutput>;
    classifyInvestigationRun(input: ClassifyInvestigationRunInput): Promise<InvestigationTestResult>;
    diagnoseInvestigationScenario(
        input: DiagnoseInvestigationScenarioInput,
    ): Promise<InvestigationScenarioDiagnosis | undefined>;
    proposeRecipeRepair(input: ProposeRecipeRepairInput): Promise<ProposeRecipeRepairOutput>;
    stageRecipeCandidateOnTwin(input: StageRecipeCandidateInput): Promise<StageRecipeCandidateOutput>;
    revertTwinRecipe(input: RevertTwinRecipeInput): Promise<RevertTwinRecipeOutput>;
    markInvestigationProgress(input: MarkInvestigationProgressInput): Promise<void>;
    reconcileInvestigationFindings(
        input: ReconcileInvestigationFindingsInput,
    ): Promise<ReconcileInvestigationFindingsOutput>;
    writeInvestigationReport(input: WriteInvestigationReportInput): Promise<WriteInvestigationReportOutput>;
    createValidationGeneration(input: CreateValidationGenerationInput): Promise<CreateValidationGenerationOutput>;
    postInvestigationPrComment(input: PostInvestigationPrCommentInput): Promise<PostInvestigationPrCommentOutput>;
    persistInvestigationEdits(input: PersistInvestigationEditsInput): Promise<PersistInvestigationEditsOutput>;
    mergeInvestigationEdits(input: MergeInvestigationEditsInput): Promise<MergeInvestigationEditsOutput>;
}
