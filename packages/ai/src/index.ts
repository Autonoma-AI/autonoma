/**
 * The model registry holds all the {@link LanguageModel} instances, tracking their usage
 * and wrapping them with monitoring capabilities.
 */

export { ModelRegistry, type LanguageModel, type VideoModel, NotAVideoModelError } from "./registry/model-registry";
export type { ModelOptions, ModelReasoningEffort } from "./registry/options";
export { MODEL_ENTRIES, OPENROUTER_MODEL_ENTRIES } from "./registry/model-entries";
export { openRouterProvider } from "./registry/providers";
export { simpleCostFunction, inputCacheCostFunction } from "./registry/costs";
export type { ModelUsage } from "./registry/usage";
export { CostCollector, type CostRecord } from "./registry/cost-collector";

export { AI_REQUEST_TIMEOUT_MS } from "./constants";
export { ObjectGenerator, ObjectGenerationFailedError } from "./object/object-generator";
export { extractMessages, buildMessages } from "./object/build-messages";
export {
    type UploadedVideo,
    type VideoUploader,
    VideoProcessor,
    VideoUploadFailedError,
    MalformedVideoUploadResultError,
} from "./object/video/video-processor";
export { type VideoInput, InvalidVideoInputError } from "./object/video/video-input";
export { InlineMp4VideoUploader } from "./object/video/inline-mp4-video-uploader";
export { VisualConditionChecker, type VisualConditionCheckerConfig } from "./visual/visual-condition-checker";
export { AssertChecker } from "./visual/assert-checker";
export { TextExtractor } from "./visual/text-extractor";
export {
    VisualChooser,
    type VisualChooserConfig,
    DEFAULT_VISUAL_CHOOSING_SYSTEM_PROMPT,
} from "./visual/visual-chooser";
export { AssertionSplitter } from "./text/assertion-splitter";

export * from "./freestyle/object";
export * from "./freestyle/point";

export type { ModelEntry } from "./registry/model-entries";

export * from "./agent";
export * from "./compaction";
