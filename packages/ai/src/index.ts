/**
 * The model registry holds all the {@link LanguageModel} instances, tracking their usage
 * and wrapping them with monitoring capabilities.
 */

export { ModelRegistry, type LanguageModel, type VideoModel, NotAVideoModelError } from "./registry/model-registry";
export type { ModelOptions, ModelReasoningEffort } from "./registry/options";
export { MODEL_ENTRIES, OPENROUTER_MODEL_ENTRIES } from "./registry/model-entries";
export { openRouterProvider } from "./registry/providers";
export { simpleCostFunction, inputCacheCostFunction, type CostFunction } from "./registry/costs";
export type { ModelUsage } from "./registry/usage";
export { CostCollector, type CostRecord } from "./registry/cost-collector";

export { AI_REQUEST_TIMEOUT_MS } from "./constants";
export { ObjectGenerator, ObjectGenerationFailedError, type ObjectGeneratorConfig } from "./object/object-generator";
export { extractMessages, buildMessages, type ObjectGenerationParams, type Base64Image } from "./object/build-messages";
export {
    type UploadedVideo,
    type VideoUploader,
    VideoProcessor,
    VideoUploadFailedError,
    MalformedVideoUploadResultError,
} from "./object/video/video-processor";
export { type VideoInput, InvalidVideoInputError } from "./object/video/video-input";
export { InlineMp4VideoUploader } from "./object/video/inline-mp4-video-uploader";
export { AssertionSplitter } from "./text/assertion-splitter";

export type { ModelEntry } from "./registry/model-entries";

import { setDefaultLogger } from "@autonoma/agent-core";
import { logger } from "@autonoma/logger";

// agent-core's loop defaults to a silent logger. Registering the backend Sentry logger here routes
// every agent built via @autonoma/ai through it; the planner CLI never imports @autonoma/ai, so it
// leaves the default silent.
setDefaultLogger(logger);

export {
    Agent,
    AgentLoop,
    type AgentConfig,
    type AgentRunResult,
    NoAgentResultError,
    MaxStepsReached,
    MultipleResultCalls,
    MODEL_MAX_RETRIES,
    AgentTool,
    type AgentToolModelOutput,
    type AgentToolModelOutputOptions,
    type AgentToolParameters,
    type ToolEnvelope,
    type AgentToolInput,
    type AgentToolOutput,
    type AgentToolSdkTool,
    ReportResultTool,
    FinishTool,
    type FinishToolParameters,
    FixableToolError,
    FatalToolError,
    logStepContent,
    type CompactionResult,
    type MessageCompactor,
    RedactOldToolResults,
} from "@autonoma/agent-core";
