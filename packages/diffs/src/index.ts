// Data types - shared shapes that flow between the pipeline stages.
export {
    type DiffAnalysis,
    type ExistingTestInfo,
    type MergeContextInfo,
    type PreClassifiedConflictInfo,
    type PreClassifiedConflictVersion,
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
    GenerationReviewer,
    type GenerationReviewerConfig,
    type GenerationReviewInput,
    ListFlowsTool,
    ListScenariosTool,
    ListTestsTool,
    ReadScenarioEntitiesTool,
    ReadScenarioRecipeEntitiesTool,
    ReadScenarioTool,
    ReadTestsTool,
    type InspectableStep,
    ReviewerLoop,
    type ScenarioDataLoop,
    type ScenarioLookupLoop,
    type ScenarioRecipeLoop,
    type StepInspectionLoop,
    type ScreenshotLoader,
    Subagent,
    SubagentLoop,
    SubagentTool,
    type SubagentConfig,
    type SubagentInput,
    type SubagentResult,
    type CreatedTest,
    MIN_DESCRIPTION_LENGTH,
    type TestLookupLoop,
    ViewFinalScreenshotTool,
    ViewStepDetailsTool,
    createTestSchema,
    validateCommand,
} from "./agents";

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
    isBaseAncestorOfHead,
    listCommitsInRange,
    type AssociatedPullRequestsReader,
    type DetectMergesParams,
    type RelevantMerge,
} from "./merge-detection";
export { mapTestSuiteToContext } from "./loaders/map-suite-to-context";
export { loadFlows } from "./loaders/load-flows";

export { Codebase } from "./codebase";

// PR-range git reads: the one implementation Impact Analysis and the classifier share.
export { readPrChangedFiles, readPrCommitSubjects, readPrDiffStat, type PrRange } from "./pr-range";

export {
    buildPlanAuthoringContext,
    type FlowSummary,
    type PlanAuthoringContextInput,
    type ScenarioDetail,
    type ScenarioSummary,
} from "./plan-authoring";

export {
    tryUploadVideo,
    MessageBuilder,
    sanitizeConversation,
    StorageEvidenceLoader,
    buildChangeContextSection,
    buildStepSummary,
    type RenderableReviewStep,
    type ReviewStep,
    type VideoDownloader,
    type EvidenceLoader,
    type ChangeContext,
} from "./review/kernel";
export { buildGenerationReviewMessages, type GenerationContext, type GenerationStepData } from "./review/generation";

// Scenario-data capability - reusable, agent-agnostic resolution + presentation
// + in-memory disclosure of the data a run's scenario actually created.
export {
    materializeScenarioData,
    resolveScenarioDataForGeneration,
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
