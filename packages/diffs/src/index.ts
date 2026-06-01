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
    GlobTool,
    GrepTool,
    HealingAgent,
    HealingAgentLoop,
    type HealingAgentConfig,
    type HealingInput,
    type HealingResult,
    ListDirectoryTool,
    ListFlowsTool,
    ListScenariosTool,
    ListTestsTool,
    type ModifiedTest,
    ReadFilesTool,
    ReadScenarioTool,
    ReadTestsTool,
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
    type ScenarioLookupLoop,
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
export { buildVerdicts, type AffectedTestWithRun } from "./loaders/build-verdicts";
export { runDiffsAgentLocally, type LocalDiffsRunnerParams } from "./run-diffs-locally";
export {
    runResolutionAgentLocally,
    type LocalResolutionRunnerParams,
    type LocalTestCandidateInput,
} from "./run-resolution-locally";

export {
    Codebase,
    type DirectoryEntry,
    type GlobOptions,
    type GrepHit,
    type GrepOptions,
    type ReadFileOptions,
} from "./codebase";

export type { FailureRecord, SnapshotInfo, PlanAuthoringInput } from "./healing/types";
export {
    healingActionSchema,
    type HealingAction,
    type UpdatePlanAction,
    type ReportBugAction,
    type ReportEngineLimitationAction,
    type RemoveTestAction,
    type HealingEvidenceItem,
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

export { tryUploadVideo, MessageBuilder, sanitizeConversation, type VideoDownloader } from "./review/kernel";
export {
    GenerationContextLoader,
    GenerationReviewPersister,
    buildGenerationReviewMessages,
    runGenerationReview,
    type PersistGenerationReviewParams,
    type RunGenerationReviewDeps,
    type RunGenerationReviewResult,
    type GenerationContext,
    type GenerationStepData,
} from "./review/generation";
export {
    RunContextLoader,
    RunReviewPersister,
    buildReplayReviewMessages,
    runReplayReview,
    type PersistRunReviewParams,
    type RunReplayReviewDeps,
    type RunReplayReviewResult,
    type RunContext,
    type RunStepData,
} from "./review/replay";
