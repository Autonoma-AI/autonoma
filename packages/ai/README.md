# @autonoma/ai

AI primitives for the Autonoma test execution platform. Provides model management, structured output generation, visual analysis, and element detection - all used by the execution agent to interact with application UIs.

## Package Exports

| Export Path | Description |
|-------------|-------------|
| `@autonoma/ai` | All core primitives (registry, generators, visual, detection) |
| `@autonoma/ai/env` | Validated environment config (`GROQ_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) |
| `@autonoma/ai/evaluation` | AI evaluation framework for benchmarking accuracy |

## Directory Structure

```
src/
├── registry/       # Model registry, entries, providers, cost tracking
├── object/         # Structured JSON output generation (+ video support)
├── visual/         # Visual condition checking, assertions, text extraction, element choosing
├── text/           # Text utilities (assertion splitting)
└── freestyle/      # Point detection and object detection
    ├── point/      # Locate a pixel coordinate from a description
    └── object/     # Detect bounding boxes from a description
```

## Model Registry

`ModelRegistry<TModel>` manages LLM instances with built-in usage tracking, cost calculation, and monitoring middleware. Models are defined as entries in `MODEL_ENTRIES` (primary providers) or `OPENROUTER_MODEL_ENTRIES` (OpenRouter fallback).

Available models:

- `GEMINI_3_FLASH_PREVIEW` - Google Gemini (default for tests and scripts); video-capable
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

Core structured output engine used by nearly every primitive in this package. Takes a Zod schema and returns validated JSON from an LLM. Supports multimodal input (text, images, video), automatic retries with exponential backoff, and tool-based agentic workflows.

```ts
import { ObjectGenerator } from "@autonoma/ai";
import z from "zod";

const generator = new ObjectGenerator({
  model,
  schema: z.object({ sentiment: z.enum(["positive", "negative", "neutral"]) }),
  systemPrompt: "Classify the sentiment of the text.",
  retry: { maxRetries: 3, initialDelayInMs: 100, backoffFactor: 2 },
});

const result = await generator.generate({ userPrompt: "I love this product!" });
// { sentiment: "positive" }
```

## Visual Primitives

### VisualConditionChecker

Checks whether a visual condition is met on a screenshot. Returns `{ metCondition: boolean, reason: string }`.

```ts
import { VisualConditionChecker } from "@autonoma/ai";

const checker = new VisualConditionChecker({ model });
const result = await checker.checkCondition("The login button is visible", screenshot);
```

### AssertChecker

Extends `VisualConditionChecker` with an assertion-specific system prompt. Used by the `assert` command.

### TextExtractor

Extracts exact text values from screenshots. Used by the `read` command.

```ts
import { TextExtractor } from "@autonoma/ai";

const extractor = new TextExtractor(model);
const result = await extractor.extractText("the order ID in the confirmation banner", screenshot);
// { value: "ORD-12345" }
```

### VisualChooser

Given multiple UI elements (with bounding boxes) and an instruction, picks which element the user wants.

### AssertionSplitter

Splits compound assertion instructions into independent atomic assertions.

```ts
import { AssertionSplitter } from "@autonoma/ai";

const splitter = new AssertionSplitter(model);
const result = await splitter.splitAssertions(
  "Check that the title is visible, the subtitle as well, but the button is not"
);
// { assertions: ["validate that the title is visible", ...] }
```

## Element Detection

### PointDetector (abstract)

Locates a single pixel coordinate on a screenshot from a natural language description.

| Implementation | Strategy |
|----------------|----------|
| `GeminiComputerUsePointDetector` | Gemini computer-use API with `click_at` tool (0-1000 coordinate space) |
| `ObjectPointDetector` | Adapter - detects a bounding box via `ObjectDetector`, returns the center point |

### ObjectDetector (abstract)

Detects bounding boxes with optional labels from a natural language prompt.

| Implementation | Strategy |
|----------------|----------|
| `GeminiObjectDetector` | Gemini structured output returning normalized 0-1000 bounding boxes |

## Video Support

A `VideoUploader` turns raw recording bytes into an `UploadedVideo` reference a message can carry. Two implementations exist, one per delivery path:

- `VideoProcessor` - uploads to the Google GenAI Files API (for the `google.generative-ai` provider).
- `InlineMp4VideoUploader` - transcodes the webm recording to mp4 with `ffmpeg` and inlines it as base64 (for OpenRouter-routed models, which reject webm).

### Coupling a model to its uploader

A video-capable model and the uploader its provider requires are declared together on the model's `MODEL_ENTRIES` entry via the optional `createUploader` factory. Consumers that watch recordings (e.g. the reviewers) ask for a `VideoModel` - the model paired with its uploader - so the two can never be mismatched:

```ts
const registry = new ModelRegistry({ models: MODEL_ENTRIES });

// { model, uploader } - the uploader matches the model's provider automatically.
const { model, uploader } = registry.getVideoModel({ model: "GEMINI_3_FLASH_PREVIEW", tag: "my-feature" }, costCollector);
```

`getVideoModel` wraps the model exactly like `getModel` (same monitoring/cost middleware) and throws `NotAVideoModelError` if the selected entry declares no `createUploader`.

## Environment Variables

Defined in `src/env.ts` using `@t3-oss/env-core`:

| Variable | Description |
|----------|-------------|
| `GROQ_KEY` | API key for Groq provider |
| `GEMINI_API_KEY` | API key for Google Gemini |
| `OPENROUTER_API_KEY` | API key for OpenRouter |

## Architecture Notes

- All primitives build on `ObjectGenerator` - visual checkers, assertion splitters, and text extractors are specialized subclasses with configured schemas and system prompts.
- `PointDetector` and `ObjectDetector` are abstract base classes. Resolution normalization is handled by the base class via `resolveResolution`.
- The `ModelRegistry` wraps AI SDK models with middleware for cost calculation, logging, and monitoring. It is a stateless, construct-once singleton.
- Cost and usage are tracked via `CostCollector`: pass one to `ModelRegistry.getModel(options, costCollector)` to capture per-call records (tokens, cost, tag), then aggregate `getRecords()` for totals.
- Video input is only supported on models that pass the `modelSupportsVideo` check (currently Google models).
- A video-capable model is coupled to its uploader on its `MODEL_ENTRIES` entry (`createUploader`); `ModelRegistry.getVideoModel` hands consumers the `{ model, uploader }` pair so the two are chosen together, never separately.
