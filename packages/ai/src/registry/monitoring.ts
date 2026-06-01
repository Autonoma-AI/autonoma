import type { LanguageModelMiddleware } from "ai";
import type { CostFunction } from "./costs";
import type { LanguageModel } from "./model-registry";
import type { ModelOptions, ModelReasoningEffort } from "./options";
import type { ModelUsage } from "./usage";
import { newModelUsage, updateModelUsage } from "./usage";

interface BaseInformation {
    name: string;
    modelId: string;
    provider: string;
    reasoning?: ModelReasoningEffort;
    tag: string;
    context: Record<string, unknown>;
    pricing: CostFunction;
}

type LanguageModelCallOptions = Parameters<LanguageModel["doGenerate"]>[0];

export interface RequestInformation extends BaseInformation {
    options: LanguageModelCallOptions;
}

type LanguageModelCallResult = Awaited<ReturnType<LanguageModel["doGenerate"]>>;

export interface ResponseInformation extends BaseInformation {
    result: Omit<LanguageModelCallResult, "usage"> & { usage: ModelUsage };
}

export interface ErrorInformation extends BaseInformation {
    error: Error;
}

export interface MonitoringCallbacks {
    onRequest: (information: RequestInformation) => void;
    onResponse: (information: ResponseInformation) => void;
    onError: (information: ErrorInformation) => void;
}

/**
 * Combine several {@link MonitoringCallbacks} into one, fanning out each hook to every
 * callback set in order. Lets a single logging middleware drive multiple consumers (e.g. a
 * registry-level monitor plus a per-call cost collector) without wrapping the model twice.
 */
export function mergeMonitoringCallbacks(callbacks: MonitoringCallbacks[]): MonitoringCallbacks {
    return {
        onRequest: (information) => {
            for (const callback of callbacks) callback.onRequest(information);
        },
        onResponse: (information) => {
            for (const callback of callbacks) callback.onResponse(information);
        },
        onError: (information) => {
            for (const callback of callbacks) callback.onError(information);
        },
    };
}

export function createLoggingMiddleware(
    options: ModelOptions,
    getContext: () => Record<string, unknown>,
    { onRequest, onResponse, onError }: MonitoringCallbacks,
    pricing: CostFunction,
): LanguageModelMiddleware {
    return {
        specificationVersion: "v3",
        wrapGenerate: async ({ doGenerate, model, params }) => {
            const context = getContext();
            const baseInfo = {
                context,
                name: options.model,
                modelId: model.modelId,
                provider: model.provider,
                reasoning: options.reasoning,
                tag: options.tag,
                pricing,
            };

            onRequest({ ...baseInfo, options: params });

            try {
                const result = await doGenerate();

                const modelUsage = updateModelUsage(newModelUsage(), result.usage);

                const resultWithUsage = {
                    ...result,
                    usage: modelUsage,
                };

                onResponse({ ...baseInfo, result: resultWithUsage });

                return result;
            } catch (error) {
                if (error instanceof Error) onError({ ...baseInfo, error });
                else onError({ ...baseInfo, error: new Error(`Unknown error: ${String(error)}`) });

                throw error;
            }
        },
    };
}
