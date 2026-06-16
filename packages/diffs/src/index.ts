// Data types - shared shapes that flow between the pipeline stages.
export {
    type DiffAnalysis,
    type ExistingTestInfo,
    type MergeContextInfo,
    type PreClassifiedConflictInfo,
    type PreClassifiedConflictVersion,
    type QuarantineInfo,
} from "./diffs-agent";

// Agents - the Agent-abstraction adoption surface.
export {
    AFFECTED_REASONS,
    affectedReasonSchema,
    affectedTestSchema,
    BashTool,
    buildCodebaseTools,
    type AffectedReason,
    type AffectedTest,
    type CodebaseLoop,
    DiffsAgent,
    DiffsAgentLoop,
    type DiffsAgentConfig,
    type DiffsAgentInput,
    type DiffsAgentResult,
    type GeneratedTest,
    GenerationReviewer,
    type GenerationReviewerConfig,
    type GenerationReviewInput,
    HealingAddTestTool,
    HealingAgent,
    HealingAgentLoop,
    type HealingAgentConfig,
    type HealingInput,
    healingNewTestSchema,
    type HealingNewTest,
    type HealingResult,
    ListFlowsTool,
    ListScenariosTool,
    ListTestsTool,
    type ModifiedTest,
    ReadScenarioEntitiesTool,
    ReadScenarioRecipeEntitiesTool,
    ReadScenarioTool,
    ReadTestsTool,
    type RejectedCandidate,
    type RemovedTest,
    ReplayReviewer,
    type ReplayReviewerConfig,
    type ReplayReviewInput,
    type ReportedBug,
    ResolutionAgent,
    ResolutionAgentLoop,
    type ResolutionAgentConfig,
    type ResolutionAgentInput,
    type ResolutionAgentResult,
    type ReviewStepScreenshots,
    ReviewerLoop,
    type RunReviewVerdict,
    type ScenarioDataLoop,
    type ScenarioLookupLoop,
    type ScenarioRecipeLoop,
    type ScreenshotInspectionLoop,
    type ScreenshotLoader,
    Subagent,
    SubagentLoop,
    SubagentTool,
    type SubagentConfig,
    type SubagentInput,
    type SubagentResult,
    type TestCandidate,
    type TestCandidateInput,
    type TestLookupLoop,
    ViewFinalScreenshotTool,
    ViewStepScreenshotTool,
    generatedTestSchema,
    modifyTestSchema,
    removedTestSchema,
    reportBugSchema,
    testCandidateSchema,
    validateCommand,
} from "./agents";

// Callbacks (resolution / report-bug etc.)
export {
    createResolutionCallbacks,
    type CreateResolutionCallbacksParams,
    type ResolutionCallbacks,
} from "./callbacks/resolution-callbacks";

export { openModelSession, type DiffsModelName, type ModelSession } from "./ai/model-session";
export { summarizeSessionCost, type SessionCostSummary } from "./ai/session-cost";

export { FlowIndex, type FlowInfo } from "./flow-index";
export { ScenarioIndex, type ScenarioInfo, type ScenarioRecipe } from "./scenario-index";

export {
    classifyTestsForMerge,
    type AssignmentRef,
    type ClassifierSource,
    type Classification,
    type ClassifyTestInput,
    type ConflictVersion,
} from "./merge-classification";
export {
    detectRelevantMerges,
    listCommitsInRange,
    type DetectMergesParams,
    type RelevantMerge,
} from "./merge-detection";
export { mapTestSuiteToContext } from "./loaders/map-suite-to-context";
export { loadFlows } from "./loaders/load-flows";
export { buildVerdicts } from "./loaders/build-verdicts";

export { Codebase } from "./codebase";

export type {
    FailureRecord,
    HealingRejectedCandidate,
    HealingTestCandidate,
    SnapshotInfo,
    PlanAuthoringInput,
} from "./healing/types";
export { bucketIterationOutcomes, type BucketedIterationOutcomes } from "./refinement/bucket-iteration-outcomes";
export {
    healingActionSchema,
    type HealingAction,
    type UpdatePlanAction,
    type ReportBugAction,
    type ReportEngineLimitationAction,
    type RemoveTestAction,
    type HealingEvidenceItem,
    type HealingReviewLink,
} from "./healing/actions";
export { BugMatcher, type BugCandidate } from "./healing/bug-matcher";
export {
    PLAN_AUTHORING_GUIDE,
    buildPlanAuthoringContext,
    type FlowSummary,
    type PlanAuthoringContextInput,
    type ScenarioDetail,
    type ScenarioSummary,
} from "./healing/plan-authoring";

export {
    tryUploadVideo,
    MessageBuilder,
    sanitizeConversation,
    StorageEvidenceLoader,
    buildChangeContextSection,
    buildLineageSection,
    buildStepSummary,
    type RenderableReviewStep,
    type ReviewStep,
    type VideoDownloader,
    type EvidenceLoader,
    type ChangeContext,
    type IterationLineage,
    type IterationVerdict,
} from "./review/kernel";
export { buildGenerationReviewMessages, type GenerationContext, type GenerationStepData } from "./review/generation";
export { buildReplayReviewMessages, type RunContext, type RunStepData } from "./review/replay";
export type { SnapshotChangeContext, SnapshotContext, SnapshotRunContext, SnapshotRunReview } from "./review/snapshot";
export type { HealingContext, HealingFailureSubject, HealingSubjectContext } from "./review/snapshot";

// Scenario-data capability - reusable, agent-agnostic resolution + presentation
// + in-memory disclosure of the data a run's scenario actually created.
export {
    materializeScenarioData,
    resolveScenarioDataForGeneration,
    resolveScenarioDataForRun,
    summarizeScenarioData,
    type ScenarioData,
    type ScenarioEntities,
    type ScenarioEntityRecord,
    scenarioDataSchema,
    scenarioEntitiesSchema,
    scenarioEntityRecordSchema,
} from "./scenario-data";

// Scenario-recipe capability - the template-level sibling of scenario-data:
// resolves + presents + discloses the data each scenario is *designed to seed*
// (its recipe `create` graph), sourced from the point-in-time
// ScenarioRecipeVersion.fixtureJson. Consumed by the diffs analysis agent, which
// runs before any replay (so no per-run instance exists yet).
export {
    materializeScenarioRecipe,
    resolveScenarioRecipesForSnapshot,
    summarizeScenarioRecipes,
    type ScenarioRecipeData,
    type ScenarioRecipeIdentity,
    scenarioRecipeDataSchema,
} from "./scenario-recipe";
