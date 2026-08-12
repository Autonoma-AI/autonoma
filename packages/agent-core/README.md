# @autonoma/agent-core

The dependency-free core of the tool-loop agent: the `AgentLoop`, the `Agent` factory, the typed `AgentTool` / `ReportResultTool` abstraction with its error taxonomy, step logging, and conversation compaction.

Its only runtime dependencies are `ai` and `zod`. It deliberately does **not** depend on `@autonoma/logger` (→ `@sentry/node`), `@autonoma/errors`, or the model registry, so it can be bundled into the published `@autonoma-ai/planner` CLI (`npx`) without dragging backend infra or heavy provider SDKs into the single-file bundle.

Two consumers share this package:

- [`@autonoma/ai`](../ai) re-exports every symbol unchanged and registers its `@autonoma/logger` singleton as the default logger at import, so backend behavior is identical to when this code lived there.
- The planner CLI depends on `@autonoma/agent-core` **only** - never on `@autonoma/ai` - keeping its bundle free of `@sentry/node`, the model registry, and `@google/genai`.

## Directory Structure

```
src/
├── agent/          # Agent, AgentLoop, AgentTool, ReportResultTool/FinishTool, tool-errors, log-step
├── compaction/     # MessageCompactor contract + RedactOldToolResults strategy
├── logger.ts       # Minimal Logger interface + noopLogger + setDefaultLogger/getDefaultLogger seam
├── model.ts        # LanguageModel type alias (single source of truth; the registry re-exports it)
├── retry.ts        # buildRetry: capped exponential backoff honoring Retry-After, retryable-only
└── index.ts        # Public barrel
```

## Retry helper

`buildRetry(config)` returns a wrapper that retries an async model call with capped exponential
backoff, honoring provider `Retry-After` / `retry-after-ms` headers and the `APICallError.isRetryable`
signal (permanent 4xx fail fast; 429/5xx and network drops retry). `DEFAULT_RETRY_CONFIG` is the
generous policy `@autonoma/ai`'s `ObjectGenerator` uses; a CLI can wrap its one-shot `generateText`
calls with it to get the same robustness the agent loop already has per-step.

## The logger seam

`AgentLoop` and `AgentTool` never import a concrete logger. They log through the minimal `Logger` interface (`child`/`info`/`warn`/`error`/`fatal`), resolved from the process-wide default registered via `setDefaultLogger(...)` - the silent `noopLogger` until one is set. The loop and its tools all derive their child loggers from that single default, so they never diverge.

`@autonoma/ai` calls `setDefaultLogger(logger)` once at import with its Sentry-backed logger. A CLI calls it once at startup with a thin adapter (e.g. into a `DEBUG`-gated channel) so loop internals never hit normal stdout but stay recoverable. Per-run context comes from the loop's `name` child binding, not from separate logger instances.

## The loop, briefly

`AgentLoop` forces `toolChoice: "required"` on every step and stops only when the report tool has produced a result (`hasProducedResult`), never on a bare tool call - so a rejected `finish` (thrown as a `FixableToolError`) is delivered back to the model and self-corrects in the same loop.

`hasProducedResult` is evaluated at the END of a step, so a second report call can only ever be a second tool call inside the same assistant message - never a revision the loop had a chance to act on. `setResult` therefore keeps the first result and throws `MultipleResultCalls`, a `FixableToolError`: the step finishes, the stop condition trips, and the first result is what the caller gets. Both payloads are logged at `warn`, so it stays visible whether the two calls agree - if they systematically disagree, first-wins is the wrong default. The guard tests `!== undefined`, not `!= null`, so that a result type admitting `null` cannot set a value that stops the loop yet slips past the guard.

## Declinable fields

`declinable(schema)` wraps a model-filled field that must be emitted but may have nothing behind it: nullable on the wire, `undefined` after the parse. Under OpenAI's strict structured-output mode every property has to appear in `required`, so `.optional()` does **not** make a field omittable - null is the only way the model can decline. Say "pass null" in a declinable field's `.describe()`, never "omit".

## Failure carries the transcript

Every way a run can end without a result throws an `AgentLoopError`, and every one carries `conversation` plus an optional `snapshotPartial()` payload. Catch the base class when all you want is the transcript.

|                         | thrown when                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MaxStepsReached`       | the step budget ran out before the report tool fired                                                                                                                                                                                                                                                                              |
| `NoAgentResultError`    | the loop ended some other way without a result                                                                                                                                                                                                                                                                                    |
| `AgentGenerationFailed` | the model call itself rejected - the provider exhausted `MODEL_MAX_RETRIES`, prompt conversion failed, or a `prepareStep`/`onStepFinish` hook threw. Wraps the underlying error on `.cause` **and** inlines its message, because failures get categorized by string once Temporal has serialized them across an activity boundary |
| `ToolCallFailedFatally` | a tool threw a `FatalToolError`, or any unclassified error under `stop_unless_fixable`. Carries the tool's name and the original error on `.cause`                                                                                                                                                                                |

The transcript survives a rejected model call because the loop captures the SDK's cumulative `response.messages` after every step rather than reading them off the resolved result. A run that dies on its very first call reports an empty `conversation` rather than failing some other way.

`buildTranscript(userPrompt, modelMessages)` shapes what a caller persists - use it to ADD context the agent could not otherwise recover, such as a prompt built from non-deterministic pre-loop work. The loop applies it on the success path _and_ on every failure path, so an override cannot accidentally cover only the happy one. That is the trap it replaces: a subclass wrapping `runLoop` can only shape the value it returns, so its prompt context silently vanished from exactly the runs worth debugging.

**A transcript never carries inline media.** `stripMedia` runs on every transcript the loop hands out, after `buildTranscript`, replacing image and file bytes with a short placeholder - so no override can reintroduce them. This is not optional because transcripts get JSON-serialized into storage, and a single screenshot is a multi-megabyte base64 string; a run that inspects a dozen frames would write a record orders of magnitude larger than the reasoning anyone wants to read out of it. Note that images arrive through tool **results** (a frame-viewing tool returns inline media via `toModelOutput`), not just prompts, so both paths are stripped. Media worth keeping is addressed by a storage key on the record that references it.

**Nor do the logs.** `AgentTool` runs every value it logs through `redactForLog`, which replaces any string over 4 KB with a note of its length - the Sentry SDK does not truncate log attributes, so an un-elided frame ships whole. It is a size rule rather than a media rule so the next tool returning something enormous is covered without opting in; the transcript still holds every result in full.

A `FatalToolError` ending the run needs explaining, because the throw alone does not do it. Since `ai@5.0.0` the SDK converts every tool exception into a `tool-error` content part and continues, so nothing a tool throws escapes `generate()` - which left `FatalToolError` inert, the loop sailing past a capability that had declared itself unusable. `AgentTool` now reports the failure to the loop at the throw site (`recordFatalToolError`) and the loop stops at the end of that step. Invoke a tool outside the `AgentTool` wrapper and you lose the guarantee.
