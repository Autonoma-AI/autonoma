# @autonoma/ai

Core AI primitives for the Autonoma test execution platform: model management, structured output generation, the reusable agent abstraction, and text utilities. **Sharp-free** - it has no dependency on `@autonoma/image`, so it is safe to load in hosts without the `sharp` native binary (e.g. the API).

Screenshot-driven primitives (visual checkers, point/object detection) live in [`@autonoma/visual-ai`](../visual-ai), which depends on this package and on `@autonoma/image`.

The tool-loop agent abstraction (`AgentLoop`, `Agent`, `AgentTool`, `ReportResultTool`) and conversation compaction live in the dependency-free [`@autonoma/agent-core`](../agent-core) package so they can be bundled into the published planner CLI without pulling in `@autonoma/logger`/`@sentry/node` or the model registry. This package re-exports every one of those symbols unchanged, and registers its `@autonoma/logger` singleton as the loop's default logger at import - so consumers of `@autonoma/ai` see no difference.

## Package Exports

| Export Path               | Description                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@autonoma/ai`            | Core primitives: registry, `ObjectGenerator`, `TextGenerator`, video, text utilities, the AI SDK message types the API speaks in, plus re-exported agent + compaction from `@autonoma/agent-core`. No `sharp`. |
| `@autonoma/ai/env`        | Validated environment config (`GROQ_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`)                                                                                                                              |
| `@autonoma/ai/evaluation` | Generic AI evaluation framework for benchmarking accuracy                                                                                                                                                      |

## Directory Structure

```
src/
├── build-messages.ts  # Shared prompt/image/video/raw-message assembly for both generators
├── run-generation.ts  # Shared generation policy: retry, timeout, telemetry, video guard, error wrapping
├── registry/          # Model registry, entries, providers, cost tracking
├── object/            # Structured JSON output generation (+ video support)
└── text/              # Free-text generation + text utilities (assertion splitting)
```

The agent abstraction (`agent/`) and compaction strategies (`compaction/`) moved to [`@autonoma/agent-core`](../agent-core) and are re-exported from this package's barrel for backward compatibility.

## Model Registry

`ModelRegistry<TModel>` manages LLM instances with built-in usage tracking, cost calculation, and monitoring middleware. Models are defined as entries in `MODEL_ENTRIES` (primary providers) or `OPENROUTER_MODEL_ENTRIES` (OpenRouter fallback).

Available models:

- `GEMINI_3_FLASH_PREVIEW` - Google Gemini (default for tests and scripts); video-capable
- `GEMINI_3_5_FLASH_LITE` - Google Gemini Flash-Lite; cheaper/faster, web agent-loop model; video-capable
- `QWEN3_VL_32B` - Qwen3-VL via OpenRouter; grounding/pointer model (provider pinned to structured-output-capable providers)
- `MINISTRAL_8B` - Mistral via OpenRouter
- `GPT_OSS_120B` - OpenAI OSS via Groq or OpenRouter
- `MINIMAX_M3` - MiniMax via OpenRouter; video-capable

```ts
import { ModelRegistry, MODEL_ENTRIES } from "@autonoma/ai";

const registry = new ModelRegistry({
    models: MODEL_ENTRIES,
    defaultSettings: { temperature: 0 },
});

const model = registry.getModel({
    model: "GEMINI_3_FLASH_PREVIEW",
    tag: "my-feature",
    reasoning: "low",
});
```

### Reasoning Effort

Cross-provider reasoning configuration: `"none" | "low" | "medium" | "high"`. Automatically mapped to provider-specific parameters (Groq `reasoningEffort`, Google `thinkingConfig.thinkingLevel`).

### Cost Tracking

`CostCollector` hooks into registry monitoring callbacks to capture per-call token usage and cost in microdollars.

There are two ways to attach a collector:

**Construction-time** - bind a collector to every call the registry issues. Use this when the registry is built per run:

```ts
import { CostCollector } from "@autonoma/ai";

const costCollector = new CostCollector();
const registry = new ModelRegistry({
    models: MODEL_ENTRIES,
    monitoring: costCollector.createMonitoringCallbacks(),
});

// ... run AI calls ...

const records = costCollector.getRecords();
// [{ model, tag, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, costMicrodollars }]
```

**Per-call** - pass a collector to `getModel` so a single, shared (construct-once) registry can attribute cost to a per-run collector without being rebuilt. This composes with (does not replace) any construction-time `monitoring`:

```ts
const registry = new ModelRegistry({ models: MODEL_ENTRIES });

const costCollector = new CostCollector();
const model = registry.getModel({ model: "GEMINI_3_FLASH_PREVIEW", tag: "my-feature" }, costCollector);

// ... run AI calls with `model` ...

const records = costCollector.getRecords();
```

## ObjectGenerator

Core structured output engine used by nearly every primitive in this package. Takes a Zod schema and returns validated JSON from an LLM. Supports multimodal input (text, images, video) and automatic retries with capped exponential backoff (10 retries by default, only retrying transient/retryable provider errors).

```ts
import { ObjectGenerator } from "@autonoma/ai";
import z from "zod";

const generator = new ObjectGenerator({
    model,
    schema: z.object({ sentiment: z.enum(["positive", "negative", "neutral"]) }),
    systemPrompt: "Classify the sentiment of the text.",
    // Optional; per-attempt ceiling, defaults to AI_REQUEST_TIMEOUT_MS.
    timeoutMs: 2 * 60_000,
    // Optional; defaults to 10 retries with capped exponential backoff.
    retry: { maxRetries: 10, initialDelayInMs: 1000, backoffFactor: 2, maxDelayInMs: 30_000 },
});

const result = await generator.generate({ userPrompt: "I love this product!" });
// { sentiment: "positive" }
```

Image input is typed as `Base64Image` (`{ base64: string }`) rather than a concrete `Screenshot`, which is what keeps this package free of `@autonoma/image`. `@autonoma/image`'s `Screenshot` satisfies the shape structurally, so callers pass `Screenshot` instances directly.

## TextGenerator

The free-text counterpart to `ObjectGenerator`, for the calls whose answer is prose rather than a schema - asking a vision model what an error toast said, describing a recording. **No caller needs to import the AI SDK to ask a model a plain question.**

Both generators are thin policy over one shared `runGeneration`, which owns everything that is not "what shape of answer did you ask for": prompt assembly, the video-capability guard, the per-attempt timeout, telemetry, retry ownership (`maxRetries: 0` on the SDK call, so the two retry layers cannot multiply), and wrapping whatever failed in one typed error. Adding a third kind of generation means writing its `generateText` call and its error class, nothing else - and a fix to the shared policy lands in both rather than in whichever one someone remembered.

```ts
import { TextGenerator } from "@autonoma/ai";

const generator = new TextGenerator({
    model: visionModel,
    // Per-attempt ceiling; defaults to AI_REQUEST_TIMEOUT_MS. A full-video read costs minutes
    // where a single frame answers in seconds, so set it per use case.
    timeoutMs: 3 * 60_000,
    // Optional; defaults to 10 retries with capped exponential backoff.
    retry: { maxRetries: 3, initialDelayInMs: 1000, backoffFactor: 2, maxDelayInMs: 10_000 },
});

const answer = await generator.generate({ userPrompt: "What error is on screen?", images: [screenshot] });
```

Two things to get right when choosing `retry` alongside `timeoutMs`: `buildRetry` treats a **timeout** as transient (it is not an `APICallError`), so `maxRetries` multiplies `timeoutMs` into the worst-case wall clock - pass a tighter policy when the caller sits under a deadline of its own, such as a Temporal `startToCloseTimeout`. Inline media - a recording sent as bytes rather than as an uploaded Files-API URI - goes through `rawMessages`, since the `video` param is for the uploaded-URI path.

## Text Primitives

### AssertionSplitter

Splits compound assertion instructions into independent atomic assertions.

```ts
import { AssertionSplitter } from "@autonoma/ai";

const splitter = new AssertionSplitter(model);
const result = await splitter.splitAssertions(
    "Check that the title is visible, the subtitle as well, but the button is not",
);
// { assertions: ["validate that the title is visible", ...] }
```

## Video Support

A `VideoUploader` turns raw recording bytes into an `UploadedVideo` reference a message can carry. Two implementations exist, one per delivery path:

- `VideoProcessor` - uploads to the Google GenAI Files API (for the `google.generative-ai` provider).
- `InlineMp4VideoUploader` - transcodes the webm recording to mp4 with `ffmpeg` and inlines it as base64 (for OpenRouter-routed models, which reject webm). It runs `ffmpeg` from PATH by default; a host whose image does not ship one passes the bundled binary instead (`new InlineMp4VideoUploader(ffmpeg.path)`). Its `transcodeToMp4(bytes)` is public for callers that attach the video themselves as an AI SDK `file` part and only need the format conversion.

### Coupling a model to its uploader

A video-capable model and the uploader its provider requires are declared together on the model's `MODEL_ENTRIES` entry via the optional `createUploader` factory. Consumers that watch recordings (e.g. the reviewers) ask for a `VideoModel` - the model paired with its uploader - so the two can never be mismatched:

```ts
const registry = new ModelRegistry({ models: MODEL_ENTRIES });

// { model, uploader } - the uploader matches the model's provider automatically.
const { model, uploader } = registry.getVideoModel(
    { model: "GEMINI_3_FLASH_PREVIEW", tag: "my-feature" },
    costCollector,
);
```

`getVideoModel` wraps the model exactly like `getModel` (same monitoring/cost middleware) and throws `NotAVideoModelError` if the selected entry declares no `createUploader`.

## Environment Variables

Defined in `src/env.ts` using `@t3-oss/env-core`:

| Variable             | Description               |
| -------------------- | ------------------------- |
| `GROQ_KEY`           | API key for Groq provider |
| `GEMINI_API_KEY`     | API key for Google Gemini |
| `OPENROUTER_API_KEY` | API key for OpenRouter    |

## Architecture Notes

- Most primitives build on `ObjectGenerator` - the assertion splitter and the visual primitives in `@autonoma/visual-ai` are specialized subclasses with configured schemas and system prompts.
- The `ModelRegistry` wraps AI SDK models with middleware for cost calculation, logging, and monitoring. It is a stateless, construct-once singleton.
- Cost and usage are tracked via `CostCollector`: pass one to `ModelRegistry.getModel(options, costCollector)` to capture per-call records (tokens, cost, tag), then aggregate `getRecords()` for totals.
- Video capability is declared by the registry entry, not guessed from the provider: an entry that can take video declares a `createUploader`, and `ModelRegistry.getVideoModel` hands back the model paired with that uploader (throwing `NotAVideoModelError` otherwise). Google entries use the Files-API `VideoProcessor`; OpenRouter-routed entries use `InlineMp4VideoUploader`, which returns the mp4 as base64 for a `file` part. Acquiring the model IS the capability check - there is no second runtime guard.
- A video-capable model is coupled to its uploader on its `MODEL_ENTRIES` entry (`createUploader`); `ModelRegistry.getVideoModel` hands consumers the `{ model, uploader }` pair so the two are chosen together, never separately.
