# @autonoma/visual-ai

Screenshot-driven AI primitives for the Autonoma test execution platform: visual condition checking, assertions, text extraction, element choosing, and point/object detection. These operate on `Screenshot` images and are used by the execution agent to interact with application UIs.

## Layering

```
@autonoma/visual-ai
├── @autonoma/ai      # core primitives: ObjectGenerator, ModelRegistry, buildMessages
└── @autonoma/image   # Screenshot + geometry (-> sharp native binary)
```

This package depends on `sharp` (via `@autonoma/image`). Hosts that only need text / structured generation and cannot load the `sharp` native binary (e.g. the API) should use [`@autonoma/ai`](../ai) directly, which is sharp-free.

## Package Exports

| Export Path | Description |
|-------------|-------------|
| `@autonoma/visual-ai` | Visual checkers + point/object detection |

## Directory Structure

```
src/
├── visual/         # Visual condition checking, assertions, text extraction, element choosing
└── freestyle/      # Point detection and object detection
    ├── point/      # Locate a pixel coordinate from a description
    └── object/     # Detect bounding boxes from a description
```

## Visual Primitives

### VisualConditionChecker

Checks whether a visual condition is met on a screenshot. Returns `{ metCondition: boolean, reason: string }`.

```ts
import { VisualConditionChecker } from "@autonoma/visual-ai";

const checker = new VisualConditionChecker({ model });
const result = await checker.checkCondition("The login button is visible", screenshot);
```

### AssertChecker

Extends `VisualConditionChecker` with an assertion-specific system prompt. Used by the `assert` command.

### TextExtractor

Extracts exact text values from screenshots. Used by the `read` command.

```ts
import { TextExtractor } from "@autonoma/visual-ai";

const extractor = new TextExtractor(model);
const result = await extractor.extractText("the order ID in the confirmation banner", screenshot);
// { value: "ORD-12345" }
```

### VisualChooser

Given multiple UI elements (with bounding boxes) and an instruction, picks which element the user wants.

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

Both `PointDetector` and `ObjectDetector` are abstract base classes; resolution normalization is handled by the base class via `resolveResolution`.

## Models and Environment

Models and API keys come from `@autonoma/ai`: build a `ModelRegistry` from `MODEL_ENTRIES`, and configure `GEMINI_API_KEY` / `GROQ_KEY` / `OPENROUTER_API_KEY` per `@autonoma/ai/env`.

## Scripts

```bash
# Detect bounding boxes for an image + prompt, writing results to a gitignored bounding-boxes/ dir
pnpm --filter @autonoma/visual-ai detect-object <image-path> "<prompt>"
```
