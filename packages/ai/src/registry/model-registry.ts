import {
    type LanguageModel as AISDKLanguageModel,
    type LanguageModelMiddleware,
    defaultSettingsMiddleware,
    wrapLanguageModel,
} from "ai";
import type { VideoUploader } from "../object/video/video-processor";
import type { CostCollector } from "./cost-collector";
import type { CostFunction } from "./costs";
import type { ModelEntry } from "./model-entries";
import { type MonitoringCallbacks, createLoggingMiddleware, mergeMonitoringCallbacks } from "./monitoring";
import { type ModelOptions, type ModelSettings, buildSettings } from "./options";

export type LanguageModel = Extract<AISDKLanguageModel, { specificationVersion: "v3" }>;

/**
 * A video-capable model bundled with the {@link VideoUploader} its provider requires.
 *
 * Consumers that watch recordings (e.g. the reviewers) receive this single object rather than a
 * model and an uploader chosen independently, so the two can never be mismatched.
 */
export interface VideoModel {
    model: LanguageModel;
    uploader: VideoUploader;
}

/** Thrown when {@link ModelRegistry.getVideoModel} is asked for a model that declares no uploader. */
export class NotAVideoModelError extends Error {
    constructor(modelName: string) {
        super(`Model "${modelName}" is not a video model: its registry entry declares no createUploader`);
    }
}

interface ModelRegistryConfig<TModel extends string> {
    models: Record<TModel, ModelEntry>;
    defaultSettings?: Omit<ModelSettings, "providerOptions">;
    monitoring?: MonitoringCallbacks;
}

/**
 * The model registry holds all the {@link LanguageModel} instances, wrapping them with
 * monitoring capabilities. It is a stateless, construct-once singleton: per-run cost
 * attribution flows through a {@link CostCollector} passed to {@link getModel}.
 */
export class ModelRegistry<TModel extends string> {
    private readonly models: Record<TModel, LanguageModel>;
    private readonly pricing: Record<string, CostFunction>;
    private readonly uploaders: Record<string, VideoUploader>;
    private readonly defaultSettings?: Omit<ModelSettings, "providerOptions">;
    private readonly monitoring?: MonitoringCallbacks;

    constructor({ models, defaultSettings, monitoring }: ModelRegistryConfig<TModel>) {
        const entries: [TModel, ModelEntry][] = Object.entries(models).map(([key, entry]) => [
            key as TModel,
            entry as ModelEntry,
        ]);

        const createdModels = Object.fromEntries(entries.map(([key, entry]) => [key, entry.createModel()])) as Record<
            TModel,
            LanguageModel
        >;

        this.models = createdModels;

        this.pricing = Object.fromEntries(entries.map(([key, entry]) => [createdModels[key].modelId, entry.pricing]));

        this.uploaders = Object.fromEntries(
            entries.flatMap(([key, entry]) => (entry.createUploader != null ? [[key, entry.createUploader()]] : [])),
        );

        this.defaultSettings = defaultSettings;
        this.monitoring = monitoring;
    }

    /**
     * Acquire a wrapped {@link LanguageModel} for the given options.
     *
     * When a per-call {@link CostCollector} is supplied, its monitoring callbacks are merged with
     * (not replacing) any registry-level `monitoring` set at construction, and both are driven by a
     * single logging middleware. This lets a shared, construct-once registry attribute cost to a
     * per-run collector without rebuilding the registry.
     */
    public getModel(options: ModelOptions<TModel>, costCollector?: CostCollector): LanguageModel {
        const settings = buildSettings({ ...this.defaultSettings, ...options });
        const model = this.models[options.model];
        // biome-ignore lint/style/noNonNullAssertion: This is guaranteed by construction
        const pricing = this.pricing[model.modelId]!;

        const monitoringMiddleware = this.buildMonitoringMiddleware(options, pricing, costCollector);

        return wrapLanguageModel({
            model,
            middleware: [
                ...(monitoringMiddleware != null ? [monitoringMiddleware] : []),
                defaultSettingsMiddleware({ settings }),
            ],
        });
    }

    /**
     * Acquire a {@link VideoModel} - the wrapped {@link LanguageModel} for the given options paired
     * with the {@link VideoUploader} its registry entry declares.
     *
     * The model is wrapped exactly as {@link getModel} does (same monitoring/cost middleware), so
     * cost attribution is unchanged. Throws {@link NotAVideoModelError} when the selected model
     * declares no uploader - that is a wiring bug, not a runtime condition.
     */
    public getVideoModel(options: ModelOptions<TModel>, costCollector?: CostCollector): VideoModel {
        const uploader = this.uploaders[options.model];
        if (uploader == null) throw new NotAVideoModelError(options.model);

        return { model: this.getModel(options, costCollector), uploader };
    }

    private buildMonitoringMiddleware(
        options: ModelOptions<TModel>,
        pricing: CostFunction,
        costCollector?: CostCollector,
    ): LanguageModelMiddleware | undefined {
        const callbacks: MonitoringCallbacks[] = [];

        if (this.monitoring != null) callbacks.push(this.monitoring);
        if (costCollector != null) callbacks.push(costCollector.createMonitoringCallbacks());

        if (callbacks.length === 0) return undefined;

        const merged = mergeMonitoringCallbacks(callbacks);
        return createLoggingMiddleware(options, merged, pricing);
    }
}
