import type { LanguageModel as AISDKLanguageModel } from "ai";

/**
 * The AI SDK language-model handle the agent loop drives. Narrowed to the v3 specification - the
 * only version the loop and the model registry construct. This is the single source of truth for
 * the alias; `@autonoma/ai`'s model registry re-exports it rather than redefining it.
 */
export type LanguageModel = Extract<AISDKLanguageModel, { specificationVersion: "v3" }>;
