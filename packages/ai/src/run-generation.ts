import { DEFAULT_RETRY_CONFIG, type RetryConfig, buildRetry } from "@autonoma/agent-core";
import { external } from "@autonoma/errors";
import type { ModelMessage } from "ai";
import { type GenerationParams, buildMessages } from "./build-messages";
import { AI_REQUEST_TIMEOUT_MS } from "./constants";
import type { LanguageModel } from "./registry/model-registry";

/** The settings every generation in this package shares, ready to spread into a `generateText` call. */
export interface GenerationSettings {
    model: LanguageModel;
    system?: string;
    messages: ModelMessage[];
    /**
     * Retries are owned by the wrapper below, which honours provider `Retry-After` headers and fails fast on a
     * non-retryable error; letting the SDK also retry would multiply the two.
     */
    maxRetries: 0;
    timeout: number;
    experimental_telemetry: { isEnabled: true };
}

/** What every generator in this package is configured with, whatever shape of answer it asks for. */
export interface GeneratorConfig {
    model: LanguageModel;
    systemPrompt?: string;

    /**
     * Ceiling on a single attempt, after which the call is aborted and the retry policy decides whether to
     * re-issue it. Defaults to {@link AI_REQUEST_TIMEOUT_MS}. Set it per use case: a full-video read costs
     * minutes where a single frame answers in seconds, and the point of the bound is to fail a hung provider
     * connection rather than to cut off a call that is legitimately still working.
     */
    timeoutMs?: number;

    /**
     * Retry policy. Defaults to {@link DEFAULT_RETRY_CONFIG} (10 retries, capped backoff).
     *
     * Note that {@link buildRetry} treats a timeout as transient, so `maxRetries` multiplies {@link timeoutMs}
     * into the worst-case wall clock - pass a tighter policy when the caller sits under a deadline of its own.
     */
    retry?: RetryConfig;
}

/**
 * Run one model call with this package's shared policy: prompt assembly, a bounded per-attempt timeout,
 * telemetry, retries owned in one place, and a single typed error wrapping whatever comes out.
 *
 * Video capability is NOT checked here: it is declared by the registry entry and enforced when the model is
 * acquired via `ModelRegistry.getVideoModel`, so a caller holding an `UploadedVideo` already went through an
 * uploader only a video-capable entry could give it.
 *
 * `call` receives the settings to spread into its own `generateText` and returns the answer in whatever shape
 * it wanted - a schema-validated object, free text - which is the only thing that actually differs between the
 * generators built on this.
 */
export async function runGeneration<TResult>(
    config: GeneratorConfig,
    params: GenerationParams,
    wrapError: (cause: Error) => Error,
    call: (settings: GenerationSettings) => Promise<TResult>,
): Promise<TResult> {
    const { model, systemPrompt, timeoutMs, retry } = config;

    const settings: GenerationSettings = {
        model,
        system: systemPrompt,
        messages: buildMessages(params),
        maxRetries: 0,
        timeout: timeoutMs ?? AI_REQUEST_TIMEOUT_MS,
        experimental_telemetry: { isEnabled: true },
    };

    const retryOperation = buildRetry(retry ?? DEFAULT_RETRY_CONFIG);
    return await external(() => retryOperation(() => call(settings)), { wrapper: wrapError });
}
