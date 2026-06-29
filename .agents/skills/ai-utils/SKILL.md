---
name: ai-utils
description: "Always read this skill before editing any file under packages/ai/. Covers AI primitives: the agent abstraction, model registry, structured output generation, visual checkers, and element detection used across the platform."
---

# AI Utils (`@autonoma/ai`)

`@autonoma/ai` provides the AI primitives used across the platform: the reusable agent abstraction, model management, structured output generation, visual analysis, and element detection.

This skill is the conceptual map. The live model list, package exports, and detailed usage examples are maintained in `packages/ai/README.md` - treat that README (and `registry/model-entries.ts` for the models) as the source of truth and update it when behavior changes.

## Agent Abstraction (`agent/`)

The most important building block in this package. It is the generic, reusable tool-loop agent that every agentic workflow extends - the reviewers, healing, resolution, and diffs agents in `packages/diffs` are all subclasses. (Note: the *test-execution* agent in `@autonoma/engine` is separate and wraps the AI SDK directly; this abstraction is for the non-execution, reasoning-style agents.) It wraps the Vercel AI SDK's `ToolLoopAgent` and adds typed results, typed tool error handling, and optional message compaction.

Three classes form the core, with a clean immutable-config / per-run-state split:

- **`Agent<TGenerationInput, TResult, TLoop>`** - an immutable factory holding config and dependencies. Each `run(input)` builds a fresh per-run loop. Subclasses implement two hooks:
  - `buildUserPrompt(input)` - async, so pre-loop work (uploading a video, computing a diff) can feed the prompt.
  - `createLoop(input)` - construct the per-run `AgentLoop` carrying any state the tools will read.

- **`AgentLoop<TResult>`** - holds all mutable state for a single run and drives the `ToolLoopAgent`. Configured via `AgentConfig` (`name`, `model`, `systemPrompt`, `tools`, `reportTool`, optional `maxSteps`, optional `compactor`). The loop stops when the report tool produces a result or `maxSteps` is hit. Overridable hooks: `prepareStep` (inject per-step messages/settings), `onStepFinish` (per-step side effects; default logs the step), `snapshotPartial` (expose a partial result on failure). The system prompt is fixed at construction - anything per-run belongs in the user prompt.
  - Terminal errors: `NoAgentResultError`, `MaxStepsReached`, `MultipleResultCalls`.
  - `run` / `runLoop` return `AgentRunResult<TResult>`: `{ result, conversation }`, where `conversation` is the raw, uncompacted message stream.

- **`AgentTool<TInput, TOutput, TLoop>`** - a thin wrapper over the AI SDK `Tool` with typed error handling and access to the loop via `execute(input, loop)`. Failures are classified:
  - Throw `FixableToolError` (with a `suggestFix()` message) to feed an error back to the model and continue.
  - Throw `FatalToolError` to stop the loop and propagate.
  - The `errorHandling` policy (`continue_unless_fatal` default, or `stop_unless_fixable`) decides how *unclassified* exceptions are treated.
  - Output is wrapped in a `ToolEnvelope` (`{ success, result | error, fixSuggestion }`).

- **Reporting the result**: extend `ReportResultTool` (its `buildResult(input, loop)` can merge loop-accumulated state into the result), or use `FinishTool` when the model's final tool call already *is* the full result.

- **Compaction**: pass a `compactor` (`{ strategy, threshold }`) to compact the message history before a step once the previous step's input tokens cross the threshold. Compaction only affects what is sent to the model, never what is returned/persisted, and a strategy that throws is logged and skipped (it is a safety net, not load-bearing).

## Model Registry (`registry/`)

`ModelRegistry<TModel>` manages all LLM instances with middleware for usage tracking, cost calculation, and monitoring. Models are defined as entries in `MODEL_ENTRIES` (primary providers) and `OPENROUTER_MODEL_ENTRIES` (OpenRouter fallback) in `registry/model-entries.ts`.

- **Default model for tests and scripts**: always `GEMINI_3_FLASH_PREVIEW` (`gemini-3-flash-preview`). Never use older Gemini versions. Do not hardcode the full model list here - read `model-entries.ts`, since it changes often.
- **Providers**: `groqProvider`, `googleProvider`, `openRouterProvider` - all lazy singletons (`registry/providers.ts`).
- **Reasoning effort**: `"none" | "low" | "medium" | "high"`, mapped to provider-specific params (Groq `reasoningEffort`, Google `thinkingConfig.thinkingLevel`).
- **Cost tracking**: `CostCollector` hooks into the registry's monitoring callbacks to capture per-call token usage and cost (microdollars). Attach at construction time or pass to `getModel(options, costCollector)` for per-run attribution on a shared registry.

## ObjectGenerator (`object/`)

The core structured-output engine that most other primitives build on. Takes a Zod schema and returns validated JSON from an LLM. Features:

- Zod schema validation of the output.
- Multimodal input: text + images + video (`VideoProcessor` uploads to the Google GenAI Files API; only Google models pass the `modelSupportsVideo` check).
- Automatic retry with exponential backoff.
- Strips null bytes from responses (PostgreSQL compatibility).
- Tool support for agentic generation workflows.

## Visual Primitives (`visual/`, `text/`)

| Class | Purpose |
|-------|---------|
| `VisualConditionChecker` | Check whether a condition is met on a screenshot. Returns `{ metCondition, reason }` |
| `AssertChecker` | `VisualConditionChecker` with an assertion-specific prompt. Used by the `assert` command |
| `TextExtractor` | Extract exact text values from a screenshot. Used by the `read` command |
| `VisualChooser` | Given UI elements (with bounding boxes) + an instruction, pick the matching element |
| `AssertionSplitter` | Split a compound assertion into atomic assertions (`text/assertion-splitter.ts`) |

## Element Detection (`freestyle/`)

`PointDetector` (abstract) locates a single pixel coordinate from a description; `ObjectDetector` (abstract) detects bounding boxes. They are used by the engine's `click` and `type` commands. Concrete implementations (e.g. `GeminiComputerUsePointDetector`, `ObjectPointDetector`, `GeminiObjectDetector`) live under `freestyle/`; resolution normalization is handled in the base classes. See the README if you need a specific detector.

## Other Subsystems

- **`compaction/`** - message-compaction strategies consumed by the agent loop's `compactor`.

## Evaluation Framework (`@autonoma/ai/evaluation`)

`Evaluation<TTestCase>` integrates with Vitest to benchmark AI accuracy. `ModelEvaluation` tracks token usage and cost per model. Three eval types: assertion accuracy, click (point) detection accuracy, and wait condition accuracy.

---

For package exports, the live model list, and detailed usage examples, see `packages/ai/README.md`.
