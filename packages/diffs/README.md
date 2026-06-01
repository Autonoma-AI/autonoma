# @autonoma/diffs

AI agents that drive the diff-analysis, resolution, healing, and review pipeline. Every agent is a subclass of `Agent` from `@autonoma/ai`, built on the same abstraction: an immutable agent class holds tools + system prompt, each call constructs a fresh `AgentLoop` subclass that carries the per-run state.

## Pipeline at a glance

| Agent | Trigger | Decides |
|---|---|---|
| `DiffsAgent` | PR diffs | Which existing tests might be affected; what new tests are missing |
| `ResolutionAgent` | After replay | How to handle each failed test (modify, remove, report bug) + which candidates to graduate |
| `HealingAgent` | Refinement loop iteration | What to do about each plan that failed this iteration |
| `GenerationReviewer` | Every generation | Verdict (success / plan_mismatch / agent_limitation / application_bug) |
| `ReplayReviewer` | Every failed replay | Verdict (engine_error / application_bug) |

All five extend `Agent<TInput, TResult, TLoop>`. Callers use `.run(input)`.

## Code layout

```
src/agents/
├── capabilities.ts          Loop capability interfaces (CodebaseLoop, TestLookupLoop, …)
├── tools/                   Shared tools - typed against the narrowest capability they need
│   ├── codebase/            bash, glob, grep, list_directory, read_files (CodebaseLoop)
│   ├── lookup/              list_flows, list_tests, read_tests, list_scenarios, read_scenario
│   ├── screenshot/          view_step_screenshot, view_final_screenshot
│   └── subagent/            Nested research agent + tool wrapper
├── diffs/                   DiffsAgent + its action tools + result tool + prompt
├── resolution/              ResolutionAgent + tools + prompt
├── healing/                 HealingAgent + tools + result tool
└── reviewers/               GenerationReviewer, ReplayReviewer, shared ReviewerLoop
```

Each agent's directory contains: the `Agent` subclass, a `Loop` subclass that implements the capability interfaces the agent's tools depend on, the per-agent action/result tools, and the prompt source.

## Adding a new tool

1. Decide which capability interface(s) the tool reads off the loop. If it needs the codebase, type it against `CodebaseLoop`; if it needs the test list, `TestLookupLoop`; etc.
2. Create a file under `agents/tools/<category>/<name>-tool.ts` that exports a class extending `AgentTool<TInput, TOutput, TLoop>`.
3. Register the tool in the relevant agent's constructor (or in multiple agents if it's shared).

For action tools, push to the loop's public mutable fields directly (`loop.affectedTests.push(...)`); for cross-tool invariants, either inline the check or extract a free helper alongside the tool. The loop subclasses expose their state as `public readonly` fields - there is no separate "collector" abstraction.

## Adding a new agent

1. Create `Loop` subclass that `extends AgentLoop<TResult>` and `implements` the capability interfaces the agent's tools need.
2. Create `Agent` subclass that `extends Agent<TInput, TResult, TLoop>`. Implement `buildUserPrompt(input)` and `createLoop(input)`. Construct all tools as `private readonly` fields in the constructor.
3. If the agent has a finish tool that needs to merge collector state into the result, extend `ReportResultTool<TInput, TResult, TLoop>` and implement `buildResult(input, loop)`. Otherwise use `FinishTool<TResult>` directly.

## Error handling

Tools classify their failures explicitly:

- **Bad input the model can retry** → throw `FixableToolError` with an optional `suggestFix()` message.
- **Operation didn't succeed but the tool ran fine** (bash exit ≠ 0, file not found, no grep matches) → return success-shaped data; let the model interpret it.
- **Infra failure** → throw `FatalToolError`; the loop terminates.
- **Anything else** → caught by the default `continue_unless_fatal` policy and surfaced to the model as a fixable failure.

## Entry points

| Script | What it does |
|---|---|
| `pnpm local-diff-analysis` | Run DiffsAgent locally against a checked-out repo |
| `pnpm local-resolution` | Run ResolutionAgent locally with hand-built verdicts |

`@autonoma/diffs` is a pure agent library: it ships the `GenerationReviewer` / `ReplayReviewer` agent classes and the loader interfaces they consume (`ScreenshotLoader`, `VideoDownloader`), plus the prompt-building blocks (`buildGenerationReviewMessages`, `buildReplayReviewMessages`). All reviewer orchestration that reaches for infrastructure - the production runners (`runGenerationReview` / `runReplayReview`), the concrete context loaders, the persisters, and the read-only local CLIs (`review:generation` / `review:replay`) - lives in `apps/workers/diffs`.

## Sub-packages

| Path | Purpose |
|---|---|
| `./` | Public surface listed above |
| `./run-diffs-locally` | Local dev runner for DiffsAgent |
| `./run-resolution-locally` | Local dev runner for ResolutionAgent |
| `./prepare-runs` | `prepareRuns` callback that fires replays once the agent has marked tests affected |
| `./env` | `@t3-oss/env-core` schema for required env vars |
