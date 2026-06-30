# @autonoma/investigation

The core logic of the **shadow investigation agent** - a low-risk comparison agent that runs in parallel
with the production diffs job. For a PR it runs on its **own detached snapshot** (a baseline clone the diffs
agent never mutates), selects the affected tests **from that snapshot's pinned `TestCaseAssignment`s**, runs
each as a shadow generation **using the assignment's pinned plan**, classifies the outcome (the true cause of
pass/fail), and renders a markdown report compared against the deployed agent's result. Because selection is
scoped to the frozen snapshot, there is no time cutoff, no whole-catalog fallback, and no latest-plan lookup -
quarantined and plan-less assignments are simply skipped.

This package is **platform-agnostic logic only** - every capability (DB, S3, GitHub, the cloned repo, the
models, the preview env) is injected. The Temporal worker (`apps/workers/investigation`) wires the real
implementations; the trigger lives in `@autonoma/workflow`.

## Structure

```
src/
  schema.ts                     verdict types (Category / RunVerdict / Evidence ...)
  retry.ts                      withRetry - transient-error retry (see the WARNING in the file)
  model.ts                      ModelRegistry - OpenRouter (loop/vision) + native OpenAI (classifier)
  db/
    prior-runs.ts               PriorRuns      - has this test ever passed? (the classifier baseline)
    deployed-comparison.ts      DeployedComparison - the deployed diffs agent's result (by head SHA / by PR)
    test-catalog.ts             TestCatalog    - a snapshot's assigned tests + their pinned plans (for the selector)
  preview/
    preview-secrets.ts          PreviewSecrets     - read a repo's previewkit env (AWS SDK)
    preview-environment.ts      PreviewEnvironment - PreviewAccess impl + the run_script harness (temp dir)
  logs/loki.ts                  queryLokiLogs  - app logs over the run window (fetch + zod)
  codebase/
    local-codebase-reader.ts    LocalCodebaseReader - CodebaseReader over a clone (git/rg/sed)
  classify/
    prompt.ts                   the classifier system + verdict prompts (generic, no client specifics)
    verdict-schema.ts           the model-output schema + null->undefined normalizer
    dependencies.ts             the classifier's injected capability interfaces
    tools.ts                    the 11 investigation tools (one factory fn each)
    classify-run.ts             classifyRun - the orchestrator (investigate -> commit to a verdict)
  select/
    schema.ts · prompt.ts · dependencies.ts · tools.ts
    select-tests.ts             selectAffectedTests - pick the tests a diff affects
  report/markdown.ts            buildReportMarkdown - the S3 report (verdicts + deployed comparison)
```

## Conventions

- **Classes with constructor injection** for the stateful data modules (`PriorRuns`, `DeployedComparison`,
  `TestCatalog`, `PreviewSecrets`, `PreviewEnvironment`, `ModelRegistry`).
- **No CLIs, no raw SQL**: Prisma for the app DB, the AWS SDK for secrets/S3, `fetch` for Loki, and
  `execFile`(git/rg/sed) for the codebase reader.
- **Structured output** via `generateText({ output: Output.object({ schema }) })`.
- Every DB query has a **Testcontainers parity test**; the agents' tools have unit tests with fakes.

## Tests

```bash
pnpm --filter @autonoma/investigation test
```

DB tests use Testcontainers (a real Postgres + Prisma migrations); the rest are unit tests (mocked `fetch`,
the AI SDK `MockLanguageModelV3`, a real temp git repo for the codebase reader, a real node subprocess for
the run-script harness).
