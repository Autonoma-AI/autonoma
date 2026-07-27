# Scenario recipes over MCP - plan

Status: **in progress**. PR 1 (variables + validation) is done; PRs 2-4 are pending.

Goal: a coding agent can iterate on a scenario recipe autonomously - edit it in memory, run it against
the deployed preview, read the real error, fix, repeat - and only persist once it passes. No git push,
no user clicking "run dry run" in the UI, no broken recipe left active in between.

Trigger: onboarding dry run failed with `Unknown recipe variable: testRunId`, thrown locally in
`packages/scenario/src/scenario-recipe-resolver.ts:178` before the SDK was ever called.

## Findings

### 1. The SDK step points at the debug MCP, which has no recipe tools

- `apps/ui/.../finish-setup/index.tsx:1226` and `.../preview-config/index.tsx:92` open `ConnectAgentDialog`
  with `endpoint="debug"`.
- `apps/ui/.../onboarding/-components/previewkit/configure-with-agent-modal.tsx:41` is the only place
  that offers `endpoint="onboarding"` - i.e. the previewkit config step.
- The scenario tools (`list_scenarios`, `get_recipe`, `update_recipe`, `dry_run_scenario`, shipped in
  #1723 / #1741) live **only** on the onboarding server. So on the exact screen where recipes are
  validated, the agent the user connects cannot see a recipe at all.

### 2. Recipe variables were removed from authoring but never from the backend

The authoring path actively forbids what the backend still supports:

- `apps/cli/src/agents/03-scenario-recipe/scenario-table.ts:60` (`validateScenarioIsConcrete`) rejects
  `{{token}}`, bare `{variable}`, and `variable_fields:` in `scenarios.md` with the message
  *"there is no variable mechanism"*.
- `apps/cli/src/agents/04-recipe-builder/recipe.ts:10` (`fullRecipeSchema`) has **no `variables` field** and
  is a plain `z.object`, so a `variables` block the agent writes is silently **stripped** before
  `submitRecipe` posts the parsed object.
- But that concreteness check runs on `scenarios.md` only - **nothing validates the `create` graph inside
  `recipe.json`**. An agent can put `{{testRunId}}` there, the CLI uploads it, the API accepts it
  (`ScenarioRecipeSchema.create` is `z.record(z.string(), z.unknown())`), and it fails at `up` time.
- Meanwhile the backend (`ScenarioRecipeSchema.variables`, the resolver's `literal` / `derived` / `faker`
  strategies) and the public docs still describe a full variable system.

That is the exact failure chain behind the screenshot. **Decision: keep `testRunId` (and a short form),
drop everything else, and make it consistent in all four places** - resolver, CLI, API, docs.

### 3. `testRunId` is a trap today

- `SdkClient.up` sends `{ action: "up", create, testRunId: instanceId }` - the customer handler already
  receives `testRunId` at runtime (it is the `ScenarioInstance` UUID).
- But `{{testRunId}}` inside `create` is **not** substituted. The only supported path is a
  `derived` variable, which the CLI strips.
- `apps/docs/src/content/docs/reference/scenario-recipe-schema.md` teaches the wrong syntax twice: the
  example uses single-brace `{adminEmail}` inside `create` (the resolver matches `{{ }}`), and the derived
  `format` example uses `{shortId}`, which the resolver rejects (only `{testRunId}` is allowed).

### 4. `update_recipe` cannot catch this class of error

`ScenariosService.updateRecipe` validates `ScenarioRecipeSchema` (shape) only. Unknown/unused variables
and dangling `_ref`s are only discovered at `up` time.

### 5. The dry-run loop is destructive

`dry_run_scenario` runs the **stored active** recipe. Testing a candidate requires `update_recipe` first,
which overwrites the active recipe version (and replicates to the pending snapshot). A wrong guess leaves
a broken recipe live.

### 6. The MCP dry run cannot pick a target preview

The UI passes `targetId` (`listSdkDryRunTargets` -> `pointDeploymentAtTarget`). `ScenariosService.dryRun`
does not, so the MCP hits whatever endpoint was last stored. Note `pointDeploymentAtTarget` **persists**
the SDK URL onto the main-branch deployment - a side effect we should not inherit; `ScenarioManager.up`
already takes `sdkUrlOverride`.

### 7. Recipe merge behavior - two unrelated stories, no concurrency control

**a) Planner upload = destructive replace, no merge at all.**
`ScenarioRecipeStore.replaceScenarioRecipes` deletes every recipe version for the snapshot, recreates them,
and retargets `activeRecipeVersionId`. `ApplicationSetupService.ingestScenarioRecipesForSetup` always
targets the **main branch's active snapshot** (then replicates to pending). So the next planner upload
**silently clobbers** every recipe edit made through the UI, the MCP, or the investigation autofix. There is
no detection, no warning, and no history to recover from.

**b) Branch snapshots fork a point-in-time copy.**
`packages/test-updates/src/queries/create-branch-snapshot.ts:120` (`copyScenarioRecipeVersions`) duplicates
the source snapshot's schema snapshots + recipe versions onto the new branch snapshot. After that, the
branch and main diverge freely.

**c) The only real merge is the investigation merge-with-main flow, and it is narrow.**
`packages/investigation/src/merge/` does a 3-way LLM reconcile (BRANCH / BASE / MAIN NOW) per scenario and
writes the result onto a main **proposal** snapshot (`merge-applier.ts:152` `writeRecipeOntoProposal`).
Constraints, from `prompt.ts:44`: only the `create` graph is in scope - `name`, `description`, `variables`
and `validation` are explicitly never touched. `writeRecipeOntoProposal` silently warns and skips when the
proposal has no recipe version for that scenario. This flow lives in the investigation package, which is
being folded into "analysis", so it is not a stable place to build on.

**d) No optimistic concurrency anywhere.**
`ScenariosService.updateRecipe` takes no expected version id or fingerprint, and `applyScenarioRecipeUpdate`
**overwrites the active version row in place** (no new version row). So agent, user, and autofix all
last-write-wins with no detection, and there is nothing to roll back to. `lastSeenFingerprint` exists but
only stamps `fingerprintChangedAt`.

**e) Test coverage.** `packages/investigation/test/merge/` covers the reconcile decisions and one applier
integration test (`"writes an accepted recipe decision onto the proposal, leaving main's recipe untouched"`).
Nothing covers: the planner-upload-clobbers-an-edit path, two concurrent editors, or `variables`.

## Sequencing

Four PRs, one at a time. The first three are migration-free and independently shippable; every schema change
is deferred to the last one (beta shares the prod DB and runs no migrations, so a migration-free PR can ship
without stranding beta).

1. **Variables + validation** (W1-W6) - kills the `Unknown recipe variable: testRunId` class of error on its own.
2. **Candidate-recipe dry run** (W7-W9).
3. **MCP surface + UI** (W10-W12).
4. **History + concurrency** (W17-W21) - carries the Prisma migration (`ScenarioRecipeEdit` table, plus
   `recipeVersionId` / `recipeFingerprint` on `scenario_instance`).

## Work items

### Variables + validation

- [x] **W1** - `{{testRunId}}` and `{{testRunShortId}}` become **built-in** recipe tokens resolved from the
      request's `testRunId` (the `ScenarioInstance` UUID; short form = first 8 hex of its SHA-256). Purely
      additive - both are hard errors today.
- [x] **W2** - Retire the rest of the variable system as the *authoring* surface: keep
      `ScenarioRecipeSchema.variables` readable for recipes already stored, but stop documenting and stop
      generating `literal` / `derived` / `faker`. Consistency pass across resolver, CLI, API, docs.
- [x] **W3** - CLI: allow exactly `{{testRunId}}` / `{{testRunShortId}}` in `validateScenarioIsConcrete`,
      reject every other token, and add the same check to the `recipe.json` `create` graph (which is
      unchecked today - the actual hole).
- [x] **W4** - Docs: rewrite the variables section of `scenario-recipe-schema.md` to the two built-in tokens,
      with the correct `{{ }}` syntax.
- [x] **W5** - Pre-validate on save: run `resolveRecipePayload` + `findDanglingScenarioRefs` in
      `ScenariosService.updateRecipe`, reject with the exact message so the agent can self-correct.
- [x] **W6** - Same validation on the planner upload path (`replaceScenarioRecipes`): reject the upload with
      per-recipe errors. The planner is an agent that can fix and re-post immediately, and accepting a recipe
      we know cannot resolve just defers the failure to test time. (Whether to accept-the-good-ones is moot
      while we upload a single scenario/recipe pair; revisit if that changes.)

### Planner CLI: upload inside the agent's session, not after it

Today the SDK-integration agent validates the recipe entity-by-entity against the developer's own running
app, writes `recipe.json` + the completion marker, and **exits**. Only then does the CLI upload
(`runSubmit` -> `submitRecipe`). So a server-side rejection lands when the agent that could fix it is
already gone, and the fix costs a whole re-launch (`MAX_LAUNCH_ATTEMPTS` is 2, and the relaunch starts
cold, from `priorFailure` text alone).

The agent already shells out to the CLI throughout its session - `autonoma-planner sdk up|down|discover`
is its endpoint tool, non-interactive, JSON out, exit code = success. Upload should be one more of those.

- [ ] **W22** - Add `autonoma-planner upload-recipe`: run `findRecipeUploadProblems` locally, POST, print
      the server's error body verbatim, exit non-zero on rejection. Distinct from the existing `upload`
      command, which also re-posts artifacts and marks the setup complete - the agent wants the recipe leg
      alone, repeatably.
- [ ] **W23** - Move it into the integration prompt as a required step BEFORE the completion marker: upload,
      read the response, fix, re-upload until it returns ok. The marker then means "uploaded and accepted",
      not "wrote a file", and `runSubmit` at the end becomes an idempotent no-op safety net rather than the
      first time anyone finds out.
- [ ] **W24** - Consider the same for artifacts (KB, scenarios, tests), which upload at the very end of the
      whole pipeline (`index.ts`) and have the same failure shape.

Size: W22 + W23 are small (a subcommand over the existing `submitRecipe`, plus a prompt step). W24 is a
pipeline change and should be judged separately.

### Dry run

- [ ] **W7** - Candidate-recipe dry run. **Most of this already exists**: the investigation agent's
      `dry_run_seed` capability (`apps/workers/investigation/src/activities/propose-recipe-repair.ts:96`)
      swaps a candidate `create` graph into the stored recipe and seeds it against the live factory via
      `provisionScenarioInstance` / `teardownScenarioInstance` (`packages/scenario/src/scenario-provisioner.ts`),
      which take a `fixtureJson` directly and touch no database. Decide between reusing that (no DB writes at
      all, but `NOOP_RECORDER` means no `WebhookCall` rows and no debug trail) and adding a `recipe` option to
      `ScenarioManager.up` (keeps the `ScenarioInstance` row + call log, writes no recipe version). Leaning
      toward the manager option for the MCP, since the agent's next question after a failure is always "what
      exactly did the factory reply".
- [ ] **W8** - MCP tool shape: `dry_run_scenario({ scenarioId, recipe?, save? })`. No `recipe` = today's
      behavior. `recipe` = run the candidate, persist nothing. `recipe` + `save` = persist only on pass.
- [ ] **W9** - Target selection: `list_dry_run_targets` + optional target on the dry run, wired through
      `sdkUrlOverride` (no persisted side effect).

### MCP surface

- [ ] **W10** - Add `list_scenarios` / `get_recipe` / `dry_run_scenario` / `update_recipe` to the debug MCP.
      No onboarding gate: when a customer's software changes, the recipe MUST be fixable or they are blocked
      forever. Risk is communicated, not prohibited - the tool description and the response state what the
      write affects (how many test cases use this scenario, which revision it replaced, how to roll back),
      the same way a DB migration is warned about. The safety guard is the base fingerprint (W18), not a
      `confirm` flag: an agent will always pass `confirm: true`, but it can only produce a correct base
      fingerprint if it actually read current state first.
- [ ] **W11** - UI: add the "Debug with coding agent" button to the **dry-run step** (`DryRunList` in
      `finish-setup/index.tsx:1346`), next to "Run dry run" and prominently when a scenario fails.
      `agentDialogOpen` currently lives in the SDK step component, so `DryRunList` needs its own dialog
      instance (or the state gets lifted).
- [ ] **W12** - Docs: `apps/docs/src/content/docs/mcp/*` for whichever tools land where.

### History + concurrency

The problem to solve is not "stop concurrent edits" - it is that a result can silently describe a recipe
that no longer exists. Agent A provisions at 10:00 with revision 3, agent B edits at 10:05, the user reads
A's result at 10:10 and has no way to know it exercised something else. Three pieces fix that.

- [ ] **W17** - **Append-only recipe history.** `ScenarioRecipeVersion` is unique on `(scenarioId,
      snapshotId)` and `applyScenarioRecipeUpdate` mutates it **in place** - the relation is even named
      `ScenarioRecipeVersionHistory` but holds exactly one row per snapshot, so there is no history and no
      rollback. Add an append-only `ScenarioRecipeEdit` row per mutation (`recipeVersionId`, `fingerprint`,
      `fixtureJson`, `source: planner | ui | mcp | autofix`, `actorUserId?`, `note?`), written by every write
      path. The version row stays the "current" pointer. Recipes are small and edits are rare, so this is
      cheap.
- [ ] **W18** - **Optimistic concurrency by base fingerprint.** `update_recipe` takes the `baseFingerprint`
      returned by `get_recipe`. On mismatch, reject with a conflict that carries the CURRENT recipe + its
      fingerprint and, from W17's history, the BASE revision the caller was working from. That gives the
      agent the same three inputs the investigation reconciler uses (mine / base / theirs), so it can merge
      both changes and retry. The server detects and supplies context; it does not auto-merge.
- [ ] **W19** - **Provenance on the run.** `ScenarioInstance` records `generatedData` (the resolved payload)
      but nothing identifying which recipe revision produced it. Add `recipeVersionId` + `recipeFingerprint`,
      and surface "ran against revision N (superseded - the recipe has changed since)" in the UI and in the
      dry-run tool result. This is what makes the 10:10 case honest instead of silently stale.
- [ ] **W20** - Planner **re-upload** (not first upload - a destructive replace is correct there, nothing
      exists yet): if a stored recipe's fingerprint differs from what the planner last uploaded, it was
      edited since. Append it to history and report it instead of discarding it silently.
- [ ] **W21** - Decide where recipe merge lives once investigation folds into analysis, and cover the
      clobber + concurrent-edit paths with tests.

## onboarding vs debug MCP - divergences

| Area | onboarding | debug | Note |
|---|---|---|---|
| Addressing | pairing code -> `applicationId` | `repoFullName` (+ `prNumber`) from git remote, `list_apps` | debug is lower-friction; onboarding's code also drives the UI's "agent connected" state |
| Mutex / activity feed | every write via `guardedWrite` (soft mutex, activity log, standDown, `description` arg) | none | debug touches a **live** app and has less guarding, not more |
| Tool annotations | none | `readOnlyHint` / `destructiveHint` / `openWorldHint` on every tool | onboarding clients can't tell reads from writes |
| Config read/write | `get_config` / `apply_config` (+ `branch`), deploy is a separate `trigger_deploy` | `get_config` / `apply_config` (+ `apply`), plus partial `edit_previewkit_config` | two service paths (`services.onboarding` vs `services.previewkitWrite`) that can drift |
| Partial config edit | absent - full-document round trip for a one-field change | `edit_previewkit_config` | |
| Deploy branch | `apply_config({ branch })` | absent | |
| Secrets | `request_env` (agent never sees values) | `set_secret` (agent sets raw values) + `get_secret_status` | unreconciled policy difference; onboarding has no way to read the env surface |
| Waiting | `get_session_status` poll only | blocking `wait_for_deploy` (~45s) | onboarding agents busy-poll |
| Logs | fixed 30-line tail inside `get_session_status` | `get_build_logs` / `get_app_logs` with head/tail/filter/limit/per-service | |
| Diagnosis | absent | `diagnose_deploy` (rule-based classification) | useful during onboarding too |
| Endpoints | `previewUrl` only | `get_endpoints` incl. derived `sdkUrl` | |
| Scenario recipes | 4 tools | none | the gap this plan closes |
| Investigation | absent | `get_investigation` | correct - no runs during onboarding |
| Prompts | `configure_preview` | `debug_broken_preview`, `setup_autonoma` (AGENTS.md snippet) | `setup_autonoma` is arguably an onboarding-time action |
| Error shape | `errorResult` / `toToolResult` | also `unavailableResult` with steering text | |
