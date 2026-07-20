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

`AgentLoop` forces `toolChoice: "required"` on every step and stops only when the report tool has produced a result (`hasProducedResult`), never on a bare tool call - so a rejected `finish` (thrown as a `FixableToolError`) is delivered back to the model and self-corrects in the same loop. If the loop ends without a result it throws `MaxStepsReached` or `NoAgentResultError`, each carrying the conversation and an optional `snapshotPartial()` payload for the caller to salvage.
