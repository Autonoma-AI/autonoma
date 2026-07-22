---
name: cli-evals
description: "Read this skill when working on the planner CLI's eval harness (apps/cli/evals) - the SDK-integration eval, the planner-step evals, the artifact bootstrap - or when adding/capturing a new eval case. Covers the two eval layers, how a case is structured, how to run each eval, and how to author a new case + rubrics."
disable-model-invocation: true
---

# CLI eval harness (`apps/cli/evals`)

Two eval layers over one shared framework and one per-repo corpus. Both run the *real* thing as a
subprocess (`claude -p` for the SDK agent; the planner CLI for planner steps) rather than mocking.

- **Layer 2 - SDK-integration eval** (`sdk-integration/`): checks out a client repo at a chosen
  `sha` (which has the client's real "golden" SDK integration), strips the integration to a clean
  tree, drives `claude -p` (Bedrock) to re-implement it, and an agentic judge (OpenRouter, direct)
  compares the agent's diff to golden. This is the primary eval.
- **Layer 1 - planner-step evals** (`planner/`): re-runs one planner step (`kb`, `entityAudit`,
  `scenarioRecipe`) fresh on the clean tree and grades the produced artifact against an authored
  findings rubric with a single-shot judge.
- **Bootstrap** (`planner/bootstrap.ts`): runs the planner steps through `scenarioRecipe` on the
  clean tree to generate a case's frozen `artifacts/` (the spec both layers consume). `recipeBuilder`
  is not bootstrapped - it hands off to the SDK-integration agent, which generates `recipe.json` at
  eval time, so a case carries no frozen recipe.

## Directory map

```
apps/cli/evals/
  framework/          # shared, public: checkout, drive-claude, run-planner-step, corpus, paths,
                      #   bedrock, env, git, judge-model
  sdk-integration/    # Layer 2: run.ts, judge.ts (agentic), verdict.ts, case.ts
  planner/            # Layer 1: run.ts, bootstrap.ts, steps.ts, judge.ts (single-shot), README
  cases/<repo>/       # the corpus - one folder per client repo (OPENSOURCE-IGNORED: client IP)
  .cache/  .runs/     # gitignored: repo cache, per-run outputs
```

## A case (`cases/<repo>/`)

| file | what | required for |
|------|------|--------------|
| `input.json` | `{ owner, repo, sha, installationId }` - coordinates only, no source | both |
| `strip.patch` | `git diff` sha->clean: the client's integration removed (manually), so the tree still boots | Layer 2 |
| `artifacts/` | frozen planner spec: `project-map.json`, `pages.json`, `AUTONOMA.md`, `entity-audit.md`, `scenarios.md` (no `recipe.json` - the SDK agent generates that at eval time) | both |
| `context.json` | `{ description, testingGoal, criticalFlows }` - the planner's project context | Layer 1 / bootstrap |
| `rubrics/<step>.md` | findings rubric per gradable step | Layer 1 |
| `ENV.md` | dev-only, advisory local-boot notes (read by NO harness code) | humans |

Derived at run time: **clean** = `sha` + `strip.patch`; **golden** = the `sha` checkout as-is;
**agent** = the sandbox after the drive (its `git diff` is the agent's integration).

## Running

```bash
# env: GITHUB_APP_PRIVATE_KEY_FILE (a .pem path), OPENROUTER_API_KEY, AWS_BEARER_TOKEN_BEDROCK,
#      AUTONOMA_API_TOKEN (or AUTONOMA_API_KEY). App id + .env loading are handled (see below).

pnpm --filter @autonoma-ai/planner eval:sdk       -- --repo <name>          # Layer 2 (drive + judge)
pnpm --filter @autonoma-ai/planner eval:planner   -- --repo <name> --step entityAudit [--promote]
pnpm --filter @autonoma-ai/planner eval:bootstrap -- --repo <name> --frontend <app-dir>
```

Layer 2 flags: `--no-drive` (checkout+strip only, cheap), `--no-judge`, `--model`, `--judge-model`,
`--timeout`. Outputs land in `.runs/<repo>/<stamp>/` (`agent.diff`, `golden.diff`, transcript,
`verdict.json`). **Run Layer 2 with any host network sandbox disabled** - the Bedrock token 403s
through a proxy otherwise.

## Adding a new case

1. **Pick `sha`** - a commit that has the client's integration and boots. Confirm it's on the remote.
2. **Capture `strip.patch`** - check out `sha`, manually delete the SDK integration *and its reference
   sites* (route registration, config/env refs) so the stripped tree still builds, then
   `git add -A && git diff --cached > cases/<repo>/strip.patch`; reset the repo. Verify it applies to
   the remote `sha` (`eval:sdk --no-drive` does this).
3. **Write `input.json`** (coords + real `installationId`) and **`context.json`** (derive the three
   fields from the repo README if you don't know them - the planner needs them non-interactively).
4. **Generate `artifacts/`**: `eval:bootstrap --repo <name> --frontend <app-dir>`.
5. **Author `rubrics/<step>.md`** - a findings list a correct artifact MUST contain, grounded in the
   repo. Ground the `entityAudit` rubric in real creation functions; a good source is a passing SDK
   run (its factories prove which creation paths are real). These are a regression floor, not an oracle.
6. Optionally add `ENV.md` (dev boot notes) and run `eval:sdk --repo <name>` end to end.

## Key design decisions (don't undo these without reason)

- **No machine-read boot config.** Getting the app running locally is the driven agent's own
  best-effort job (it discovers the stack + start command). `ENV.md` is human-only docs.
- **The judge calls OpenRouter directly** (`framework/judge-model.ts`, `OPENROUTER_API_KEY`), NOT the
  CLI's `/v1/llm-proxy` credit proxy - it's harness code, not a billed customer. The **planner**
  subprocess necessarily uses the proxy (that's the only mode the product has).
- **No `@autonoma/*` workspace deps in the CLI.** The judges use the CLI's own `runAgent` + tools,
  not `@autonoma/ai`, to keep the published package's graph clean (and avoid the `sharp` pull).
- **The GitHub App id is a committed default** (`DEFAULT_GITHUB_APP_ID`, non-secret); only the private
  key is a secret, read from `GITHUB_APP_PRIVATE_KEY_FILE` (a multiline PEM breaks `--env-file`). The
  eval scripts load the repo-root `.env` via `--env-file`.
- **`cases/` is committed but opensource-ignored** (client IP: strip patches + artifacts). Client repo
  *source* is never committed - it's fetched by `sha` into the gitignored `.cache/`.
- **Bedrock for the drive, single artifact set per case** (no variant system).

## Gotchas

- A planner step can fail transiently on a weak/flaky model (empty `provider error` on
  `gemini-3-flash-preview`); `eval:planner` reports it cleanly and you re-run, or pass `--model`.
- The judge's default model id (`anthropic/claude-sonnet-4.5`) must resolve on OpenRouter; override
  with `JUDGE_MODEL`.
- Layer 1 seeds a step's *upstream* artifacts from `artifacts/` but never the step's own output, so a
  step never grades against its own frozen answer.
