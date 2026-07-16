# Planner-step eval (Layer 1)

Grades a single planner step against an authored findings rubric, and (with `--promote`) produces
the frozen artifacts that the SDK-integration eval (Layer 2) consumes. Both layers share one
per-repo corpus under `../cases/<repo>/` and run the planner against the same clean checkout.

## How a run works

```
checkout(sha) -> copy to sandbox -> git apply strip.patch (clean, no SDK)
   -> seed the frozen UPSTREAM artifacts + context.json into a private output dir
   -> run ONE planner step via the real CLI (`run --step <name> --non-interactive`)
   -> judge the produced artifact against cases/<repo>/rubrics/<step>.md
   -> [--promote] copy the artifact back into cases/<repo>/artifacts/
```

The step runs against the **clean** tree (SDK stripped) so the planner never sees the existing
integration. Upstream artifacts are seeded from `artifacts/`; the step's own output is never seeded
(so it can't read its own answer, and a resumable step starts fresh).

## Gradable steps

`kb` -> `AUTONOMA.md`, `entityAudit` -> `entity-audit.md`, `scenarioRecipe` -> `scenarios.md`,
`recipeBuilder` -> `recipe.json` (the non-interactive proposed recipe - statically gradable, no
live endpoint needed).

## Running

```bash
export AUTONOMA_API_TOKEN=...   # the planner runs its models through the managed proxy
export GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY="$(cat key.pem)"   # to fetch the client repo

pnpm --filter @autonoma-ai/planner eval:planner -- --repo <name> --step entityAudit \
     [--model <id>] [--judge-model <id>] [--promote] [--timeout <min>]
```

## Bootstrapping the artifact set

To generate the whole `artifacts/` set from scratch, use `eval:bootstrap` (runs the planner
end-to-end on the clean tree and promotes the artifacts in one go):

```bash
pnpm --filter @autonoma-ai/planner eval:bootstrap -- --repo <name> --frontend <app-dir>
```

To regenerate a single artifact afterward, re-run its step with `--promote` (its upstream is seeded
from the existing `artifacts/`):

```bash
pnpm --filter @autonoma-ai/planner eval:planner -- --repo <name> --step entityAudit --promote
```

With no rubric present, a step is run and (optionally) promoted but not judged.

## Corpus additions Layer 1 needs

Beyond what Layer 2 uses, a case adds: `cases/<repo>/context.json` (the planner's saved project
context - `{ description, testingGoal, criticalFlows }`) and `cases/<repo>/rubrics/<step>.md` (the
findings rubric per step).

A case may also carry a dev-only `cases/<repo>/ENV.md` with the verified local-boot procedure and
gotchas. It is advisory documentation for engineers only and is **not read by any harness code**
(see the SDK-integration README for the convention).
