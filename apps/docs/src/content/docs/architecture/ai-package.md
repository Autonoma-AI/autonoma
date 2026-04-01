---
title: AI Package
description: Deep dive into the AI primitives that power test execution - model registry, visual checkers, point detection, object detection, and structured output generation.
---

The `@autonoma/ai` package provides every AI primitive used by the execution agent. It handles model management, visual analysis, element location, structured output generation, and evaluation benchmarking. No AI logic should be duplicated in platform apps - everything lives here.

## Directory Structure

```
packages/ai/src/
├── index.ts                          # Package re-exports
├── env.ts                            # Environment variables (API keys)
├── registry/                         # Model registry and configuration
│   ├── model-registry.ts             # Core ModelRegistry class
│   ├── model-entries.ts              # Model definitions and pricing
│   ├── providers.ts                  # LLM provider singletons
│   ├── options.ts                    # ModelOptions, reasoning effort levels
│   ├── costs.ts                      # Cost calculation functions
│   ├── cost-collector.ts             # Aggregated cost tracking
│   ├── usage.ts                      # Token usage tracking
│   └── monitoring.ts                 # Logging middleware and telemetry
├── visual/                           # Visual AI primitives
│   ├── visual-condition-checker.ts   # Check if a condition is met on a screenshot
│   ├── assert-checker.ts             # Validate test assertions
│   ├── visual-chooser.ts             # Pick which UI element matches an instruction
│   └── text-extractor.ts             # Extract text from screenshots
├── text/
│   └── assertion-splitter.ts         # Split compound assertions into atomic ones
├── object/                           # Structured output generation
│   ├── object-generator.ts           # Core structured JSON generator
│   ├── retry.ts                      # Retry with exponential backoff
│   ├── user-messages.ts              # Build multimodal messages (text + images + video)
│   └── video/
│       ├── video-processor.ts        # Upload videos to Google GenAI Files API
│       └── video-input.ts            # Video input types and model support
└── freestyle/                        # Point and object detection
    ├── resolution-fallback.ts        # Coordinate resolution management
    ├── point/
    │   ├── point-detector.ts         # Abstract PointDetector base
    │   ├── gemini-computer-use-point-detector.ts
    │   └── object-point-detector.ts  # Adapter: ObjectDetector -> PointDetector
    └── object/
        ├── object-detector.ts        # Abstract ObjectDetector base
        └── gemini-object-detector.ts # Gemini-based bounding box detection
```

## Model Registry

`ModelRegistry<TModel>` manages all LLM instances with middleware for cost tracking and monitoring. It wraps the Vercel AI SDK's language models with usage tracking and provider-specific configuration.

### How It Works

The registry is constructed with a map of model entries. Each entry knows how to create its model instance and how to calculate costs:

```ts
const registry = new ModelRegistry({
  models: MODEL_ENTRIES,
  defaultSettings: { temperature: 0 },
  monitoring: { onGenerate: (result) => { /* log it */ } },
});
```

When you request a model, the registry wraps it with middleware for usage tracking, monitoring, and default settings:

```ts
const model = registry.getModel({
  model: "GEMINI_3_FLASH_PREVIEW",
  tag: "assert-checker",
  reasoning: "low",
});
```

The `tag` field identifies the use case (e.g., "assert-checker", "click-detector") for monitoring and cost attribution. The `reasoning` field sets the thinking effort level.

### Current Models

| Key | Model ID | Provider |
|-----|----------|----------|
| `GEMINI_3_FLASH_PREVIEW` | `gemini-3-flash-preview` | Google |
| `MINISTRAL_8B` | `mistralai/ministral-8b-2512` | OpenRouter |
| `GPT_OSS_120B` | `openai/gpt-oss-120b` | Groq |

An alternative `OPENROUTER_MODEL_ENTRIES` set routes all models through OpenRouter, including a Gemini variant (`google/gemini-3-flash-preview`) and a Llama variant (`meta-llama/llama-4-maverick`) in place of Ministral.

### Providers

Three LLM provider singletons are available, each lazily initialized with their respective API key:

| Provider | SDK | Env Variable |
|----------|-----|-------------|
| `googleProvider` | `@ai-sdk/google` | `GEMINI_API_KEY` |
| `groqProvider` | `@ai-sdk/groq` | `GROQ_KEY` |
| `openRouterProvider` | `@openrouter/ai-sdk-provider` | `OPENROUTER_API_KEY` |

The `LLMProvider` class wraps each provider as a singleton - the underlying SDK instance is created on first use.

### Reasoning Effort

The `ModelReasoningEffort` type supports four levels:

| Level | Groq | Google |
|-------|------|--------|
| `"none"` | `reasoningEffort: "none"` | Thinking disabled |
| `"low"` | `reasoningEffort: "low"` | `thinkingLevel: "low"` |
| `"medium"` | `reasoningEffort: "medium"` | `thinkingLevel: "medium"` |
| `"high"` | `reasoningEffort: "high"` | `thinkingLevel: "high"` |

Reasoning effort is translated to provider-specific options in `buildSettings()`, so callers never need to think about which provider they are targeting.

### Extra Context

The registry supports dynamic context that can be attached during execution:

```ts
registry.addContext({ testRunId: "run-123", stepIndex: 3 });
// Later...
registry.resetContext();
```

This context is passed to monitoring callbacks, making it possible to trace costs and usage back to specific test runs and steps.

## Visual AI Primitives

### VisualConditionChecker

The base class for checking whether a condition is met on a screenshot. It extends `ObjectGenerator` with a predefined schema:

```ts
const checker = new VisualConditionChecker({ model });
const result = await checker.checkCondition(
  "The login form is visible with email and password fields",
  screenshot,
);
// result: { metCondition: true, reason: "The form is visible with both fields" }
```

Returns `{ metCondition: boolean, reason: string }`.

### AssertChecker

Extends `VisualConditionChecker` with a specialized system prompt for test assertions. It handles both positive assertions ("validate there's a title that says Hello") and negative assertions ("assert there's no download button"):

```ts
const checker = new AssertChecker(model);
const result = await checker.checkCondition(
  "The submit button is disabled",
  screenshot,
);
```

Used by the `assert` command to validate each individual assertion against a screenshot.

### VisualChooser

Picks which UI element from a set of options matches a user instruction. It draws numbered bounding boxes on the screenshot and asks the model to choose:

```ts
const chooser = new VisualChooser({ model });
const result = await chooser.chooseOption({
  options: [
    { boundingBox: { x: 10, y: 20, width: 100, height: 30 }, description: "Submit" },
    { boundingBox: { x: 10, y: 60, width: 100, height: 30 }, description: "Cancel" },
  ],
  instruction: "Click the submit button",
  screenshot,
});
// result: { reasoning: "Option 1 is the submit button", option: { ... } }
```

Throws `NoValidOptionFoundError` if no option matches, or `InvalidIndexError` if the model returns an out-of-bounds index.

### AssertionSplitter

Splits a compound assertion instruction into individual atomic assertions that can be checked independently:

```ts
const splitter = new AssertionSplitter(model);
const result = await splitter.splitAssertions(
  "validate that the title is visible, the subtitle as well but the button is not",
);
// result.assertions: [
//   "validate that the title is visible",
//   "validate that the subtitle is visible",
//   "validate that the button is not visible"
// ]
```

Importantly, the splitter ensures each split assertion contains enough context to stand alone. It repairs incomplete fragments (e.g., "the subtitle as well" becomes "validate that the subtitle is visible").

## Point Detection

Point detectors locate where to interact on screen, given a natural language description. They are used by the `click`, `type`, `hover`, and `drag` commands.

### Abstract Base

All point detectors extend `PointDetector`:

```ts
abstract class PointDetector {
  protected abstract detectPointForResolution(
    screenshot: Screenshot,
    prompt: string,
    resolution: ScreenResolution,
  ): Promise<Point>;

  async detectPoint(
    screenshot: Screenshot,
    prompt: string,
    targetResolution?: ScreenResolution,
  ): Promise<Point>;
}
```

The public `detectPoint` method handles resolution fallback automatically - if no target resolution is provided, it defaults to the device resolution (if configured) or the image resolution.

### GeminiComputerUsePointDetector

Uses Google's Gemini computer-use API with a `click_at` tool. The model returns coordinates in a normalized 0-1000 space, which are then scaled to actual pixel coordinates based on the target resolution.

### ObjectPointDetector

An adapter that converts an `ObjectDetector` into a `PointDetector`. It detects the bounding box of an element and returns the center point. Useful when you have an object detector but need point-level precision.

## Object Detection

### ObjectDetector (Abstract Base)

Detects objects in an image and returns bounding boxes:

```ts
abstract class ObjectDetector {
  async detectObjects(
    screenshot: Screenshot,
    prompt: string,
    targetResolution?: ScreenResolution,
  ): Promise<DetectedObject[]>;
}
```

Each `DetectedObject` contains a `boundingBox` and an optional `label`.

### GeminiObjectDetector

Uses Gemini's structured output to return bounding boxes as normalized 0-1000 coordinates. Useful for detecting multiple UI elements at once.

## ObjectGenerator

The core structured output engine used by almost every AI primitive in the package. It wraps the AI SDK's `generateText` with:

- **Zod schema validation** for structured JSON output
- **Automatic retry** with exponential backoff (default: 5 retries, 100ms initial delay, 2x backoff factor)
- **Multimodal input** via `ObjectGenerationParams` - supports text, images, and video
- **Null byte stripping** from responses for PostgreSQL compatibility
- **Tool support** for agentic generation workflows (stops after 5 tool steps)

```ts
const generator = new ObjectGenerator({
  model,
  systemPrompt: "You are a UI analysis expert.",
  schema: z.object({
    elements: z.array(z.object({
      label: z.string(),
      visible: z.boolean(),
    })),
  }),
});

const result = await generator.generate({
  userPrompt: "List all visible buttons",
  images: [screenshot],
});
```

Video input is supported for models that handle it (checked via `modelSupportsVideo`). Videos are uploaded through the Google GenAI Files API via `VideoProcessor`.

If generation fails after all retries, an `ObjectGenerationFailedError` is thrown wrapping the original error.

## Adding a New Model

1. **Add the model entry** to `packages/ai/src/registry/model-entries.ts`:

```ts
export const MODEL_ENTRIES = {
  // ...existing entries
  MY_NEW_MODEL: {
    createModel: () => googleProvider.getModel("my-new-model-id"),
    pricing: simpleCostFunction({
      inputCostPerM: 0.5,
      outputCostPerM: 1.5,
    }),
  },
} as const;
```

2. **Choose the right cost function.** Use `simpleCostFunction` for models without cache pricing, or `inputCacheCostFunction` for models that support input caching (adds a `cachedInputCostPerM` field).

3. **Add a provider** if needed. If the model uses a provider not yet configured, add a new `LLMProvider` singleton in `providers.ts` and add the corresponding API key to `env.ts`.

4. **Use the model** by referencing its key when calling `registry.getModel()`:

```ts
const model = registry.getModel({
  model: "MY_NEW_MODEL",
  tag: "my-use-case",
  reasoning: "medium",
});
```

## Adding a New Visual AI Primitive

Most visual primitives follow the same pattern: extend `ObjectGenerator` with a specialized schema and system prompt.

1. **Define the output schema** with Zod:

```ts
const myPrimitiveSchema = z.object({
  elements: z.array(z.object({
    name: z.string(),
    confidence: z.number(),
  })),
});
type MyPrimitiveResult = z.infer<typeof myPrimitiveSchema>;
```

2. **Create the class** extending `ObjectGenerator`:

```ts
export class MyPrimitive extends ObjectGenerator<MyPrimitiveResult> {
  constructor(model: LanguageModel) {
    super({
      model,
      systemPrompt: "Your specialized system prompt here.",
      schema: myPrimitiveSchema,
    });
  }

  async analyze(screenshot: Screenshot, instruction: string): Promise<MyPrimitiveResult> {
    return this.generate({ images: [screenshot], userPrompt: instruction });
  }
}
```

3. **Export it** from the package index.

For point or object detection, extend `PointDetector` or `ObjectDetector` instead and implement the `detectPointForResolution` or `detectObjectsForResolution` method.

## Evaluation Framework

The `evals/` directory contains a Vitest-integrated framework for benchmarking AI accuracy:

- **`Evaluation<TTestCase>`** - base class that defines test cases and runs them against models
- **`ModelEvaluation`** - tracks token usage and cost per model across an evaluation run
- **Three eval types:**
  - `assert-condition/` - measures assertion checking accuracy
  - `freestyle-click/` - measures point detection accuracy
  - `wait-for-instruction/` - measures wait condition generation accuracy

Results are saved as JSON with pass rates and per-case breakdowns, making it easy to compare models and track accuracy over time.
