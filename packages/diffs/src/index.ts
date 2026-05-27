export {
    DiffsAgent,
    type DiffsAgentConfig,
    type DiffAnalysis,
    type DiffsAgentInput,
    type ExistingTestInfo,
    type MergeContextInfo,
    type PreClassifiedConflictInfo,
    type PreClassifiedConflictVersion,
    type QuarantineInfo,
} from "./diffs-agent";
export type { DiffsAgentResult, ResultCollector } from "./tools/finish-tool";
export {
    affectedReasonSchema,
    affectedTestSchema,
    AFFECTED_REASONS,
    type AffectedReason,
    type AffectedTest,
} from "./tools/mark-affected-test-tool";
export type { TestCandidate } from "./tools/suggest-test-tool";
export { FlowIndex, type FlowInfo } from "./flow-index";
export { ScenarioIndex, type ScenarioInfo, type ScenarioRecipe } from "./scenario-index";
export {
    ResolutionAgent,
    type ResolutionAgentConfig,
    type ResolutionAgentInput,
    type ResolutionAgentResult,
    type RunReviewVerdict,
    type TestCandidateInput,
} from "./resolution-agent";
export {
    createResolutionCallbacks,
    type CreateResolutionCallbacksParams,
    type ResolutionCallbacks,
} from "./callbacks/resolution-callbacks";
export type { ModifiedTest } from "./tools/modify-test-tool";
export type { RemovedTest } from "./tools/remove-test-tool";
export type { ReportedBug } from "./tools/report-bug-tool";
export type { GeneratedTest } from "./tools/add-test-tool";
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
    buildRepoTools,
    type DirectoryEntry,
    type GlobOptions,
    type GrepHit,
    type GrepOptions,
    type ReadFileOptions,
} from "./codebase";

export type { CodebaseLoop, TestLookupLoop, ScenarioLookupLoop, ScreenshotInspectionLoop } from "./agents";

export { HealingAgent, type HealingAgentConfig } from "./healing/healing-agent";
export type { HealingInput, HealingResult, FailureRecord, SnapshotInfo, PlanAuthoringInput } from "./healing/types";
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

export {
    extractVerdict,
    tryUploadVideo,
    buildScreenshotTools,
    buildVerdictTool,
    runReviewAgent,
    MessageBuilder,
    sanitizeConversation,
    type VideoDownloader,
    type ScreenshotLoader,
    type ReviewStepScreenshots,
    type BuildScreenshotToolsParams,
    type ReviewAgentResult,
    type RunReviewAgentParams,
} from "./review/kernel";
export {
    GenerationContextLoader,
    GenerationReviewer,
    GenerationReviewPersister,
    buildGenerationReviewMessages,
    runGenerationReview,
    type GenerationReviewerDeps,
    type GenerationReviewResult,
    type PersistGenerationReviewParams,
    type RunGenerationReviewDeps,
    type RunGenerationReviewResult,
    type GenerationContext,
    type GenerationStepData,
} from "./review/generation";
export {
    RunContextLoader,
    ReplayReviewer,
    RunReviewPersister,
    buildReplayReviewMessages,
    runReplayReview,
    type ReplayReviewerDeps,
    type ReplayReviewResult,
    type PersistRunReviewParams,
    type RunReplayReviewDeps,
    type RunReplayReviewResult,
    type RunContext,
    type RunStepData,
} from "./review/replay";
