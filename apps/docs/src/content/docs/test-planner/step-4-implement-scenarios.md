---
title: "Step 4: Validate Scenario Recipes"
description: "Validate the planned scenarios against the Environment Factory lifecycle and persist approved generation recipes."
---

:::note[We're simplifying this]
We know the current scenario setup is more complex than it needs to be. We're actively working on a much simpler version that should be ready in the next couple of weeks. In the meantime, the process below still works - but expect it to get significantly easier soon.
:::

The Step 4 agent takes your `discover.json` and `scenarios.md`, builds concrete scenario recipes, and validates them against the Environment Factory lifecycle that already exists in your backend. Instead of treating Step 4 primarily as "implement the endpoint," the current flow assumes the SDK is already installed and focuses on proving that each scenario can be created and cleaned up successfully.

In practice, this means Step 4:

- assembles concrete `create` payloads for `standard`, `empty`, and `large`
- checks that `up` can create the data cleanly
- checks that `down` can clean it up cleanly
- persists the approved recipes for later automation

If the backend has only a small integration gap, Step 4 can fix that. But the main path is **validation of scenario recipes**, not greenfield Environment Factory implementation.

## Prerequisites

- `autonoma/discover.json` must exist (output from [Step 2](/test-planner/step-2-scenarios/))
- `autonoma/scenarios.md` must exist (output from [Step 2](/test-planner/step-2-scenarios/))
- Your application's backend codebase must be open in the workspace, or a working Environment Factory endpoint must be reachable
- The Environment Factory must already support `discover`, `up`, and `down`
- Optionally, the `qa-tests/` directory from [Step 3](/test-planner/step-3-e2e-tests/) helps confirm what data the tests will need

## Environment requirements

If Step 4 needs to validate through the live HTTP endpoint, make sure the Claude Code session can reach it and has:

- `AUTONOMA_ENV_FACTORY_URL`
- `AUTONOMA_SHARED_SECRET`

If the backend exposes the SDK directly in-process, Step 4 should prefer local SDK-backed checks instead of external HTTP calls.

## What this produces

- `autonoma/scenario-recipes.json` - the validated recipes for `standard`, `empty`, and `large`
- Any targeted backend fixes needed to make the scenario lifecycle validate cleanly
- Validation evidence showing which strategy was used:
  - SDK-backed `checkScenario` / `checkAllScenarios`
  - or signed `discover` / `up` / `down` endpoint calls

## Review checkpoint

Before writing code or changing recipes, the agent will present a validation plan. This is still a standard approval gate - review it before the agent proceeds.

**What to check:**

- **Recipe structure** - Does each scenario recipe actually reflect the entity inventory, counts, and relationships approved in Step 2?
- **Entity creation order** - Parents must be created before children. If the plan says "create Tests before Applications" but tests reference applications, the order is wrong.
- **Cleanup order** - Teardown must remove children before parents or otherwise rely on the SDK's teardown order safely.
- **Validation strategy** - The plan should prefer SDK-backed `checkScenario` / `checkAllScenarios` when available, then fall back to signed endpoint validation only if needed.
- **Variable field handling** - Generated values from Step 2 must remain generated in the recipe. The plan should not collapse `<project_title>` back into a fixed literal.
- **Rollback claims** - If the plan says "dry run" or "transaction rollback," make sure the backend actually implements that. Otherwise the plan should describe this correctly as create-then-clean validation.

:::tip
If you're unsure about the protocol details, read the [Environment Factory Guide](/guides/environment-factory/) before reviewing the plan. The guide covers the current SDK request/response format, security model, and validation options.
:::

## The prompt

<details>
<summary>Expand full prompt</summary>

# Environment Factory Scenario Validator

You are a backend engineer. Your job is to validate the Step 2 scenarios against the application's existing Environment Factory, then persist the approved scenario recipes for later use.

The primary goal is **not** to invent new scenario data and **not** to re-implement the protocol from scratch. The goal is to:

1. read `discover.json` and `scenarios.md`
2. assemble concrete scenario recipes
3. validate that the backend can execute those recipes through `up` and `down`
4. persist the approved generation recipes to `autonoma/scenario-recipes.json`

If you discover a small missing integration detail or a validation bug in the backend, fix it. But assume the SDK-backed Environment Factory should already exist.

---

## Phase 0: Locate prerequisites

### 0.1 - Find the Step 2 artifacts

1. Check for `autonoma/discover.json` and `autonoma/scenarios.md` at the workspace root.
2. If not found, search broadly for both files anywhere in the workspace.

If either file is missing, tell the user:

> "I need both `discover.json` and `scenarios.md` to validate scenario recipes. Please run Step 2 first, then come back and run this prompt."

Do not proceed without them.

### 0.2 - Read the Environment Factory documentation

Fetch the Autonoma documentation to understand the current protocol:

1. Fetch `https://docs.agent.autonoma.app/llms.txt` to get the documentation index
2. Read the **Environment Factory Guide** - understand the current `discover`, `up`, and `down` actions, the security model, and the SDK-backed validation model
3. Read the framework example that matches this project's stack if one exists

**Always read the live docs.** The docs at `https://docs.agent.autonoma.app` are the source of truth.

### 0.3 - Read discover.json and scenarios.md

Read both files fully. Identify:

- the schema models, edges, relations, and scope field from `discover.json`
- the three scenario names (`standard`, `empty`, `large`) and their descriptions
- every entity type in the `standard` scenario, with exact counts and relationships
- the `large` scenario's volume requirements
- every generated variable token and what field it maps to

---

## Phase 1: Understand the codebase and validation surface

### 1.1 - Check backend access

Before anything else, determine if the backend codebase is accessible in this workspace.

If the backend is not accessible and there is no reachable Environment Factory endpoint, tell the user:

> "I don't have access to your backend codebase or a reachable Environment Factory endpoint, so I can't validate the scenario lifecycle. Step 4 requires one of those to be available."

Do not proceed without one of them.

### 1.2 - Confirm Environment Factory availability

Search for:

- SDK packages and adapters
- the mounted Environment Factory route/handler
- configuration for `sharedSecret` and `signingSecret`
- any local helper that wraps `checkScenario` or `checkAllScenarios`

If the SDK integration is obviously missing entirely, stop and tell the user:

> "The current Step 4 flow assumes an existing SDK-backed Environment Factory. I couldn't find one here, so this needs the SDK integration first before scenario validation can proceed."

If the SDK is present but validation appears broken or incomplete, continue and plan targeted fixes.

### 1.3 - Explore the creation patterns

After confirming the validation surface:

- map every entity in `scenarios.md` to its database table/model
- identify any unique fields that must remain generated
- identify parent/child creation order from the schema relationships
- find any existing seed helpers, factories, or test helpers worth reusing
- determine whether the backend can run SDK-backed checks locally or whether you need signed endpoint calls

**Use subagents to parallelize exploration.** One for the schema and models, one for the SDK integration, one for existing entity creation helpers.

---

## Phase 2: Plan - go into plan mode

Before writing any code, present a complete validation plan to the user:

```text
## Validation Plan

### Validation surface
[Exact file path(s) or endpoint URL(s) that will be used]

### Validation strategy
[Prefer SDK-backed checkScenario/checkAllScenarios, or explain why endpoint validation is required]

### Scenario recipe inputs
- discover source: [path]
- scenarios source: [path]
- scenario names: standard, empty, large

### Variable field handling
- [token] -> [entity field] -> [generator or runtime derivation note]

### Scenario: standard
Create order:
1. ...
2. ...

Cleanup order:
1. ...
2. ...

### Scenario: empty
Create order:
1. ...

Cleanup order:
1. ...

### Scenario: large
Create order:
1. ...

Cleanup order:
1. ...

### Validation output
- `autonoma/scenario-recipes.json`
- [any targeted backend file changes]

### Risk notes
- [e.g. unique constraints, missing auth callback, uncertain rollback support]
```

**Wait for the user to approve before proceeding.** Do not write code until the plan is approved.

---

## Phase 3: Validate and persist recipes

Implement in this order.

### 3.1 - Assemble concrete scenario recipes

Build one recipe per scenario from `discover.json` and `scenarios.md`.

Each recipe must preserve:

- scenario name and description
- entity creation structure
- explicit relation paths
- fixed values that later tests can assert directly
- generated tokens for fields that must remain dynamic

Do not collapse generated placeholders back into hardcoded literals.

### 3.2 - Prefer SDK-backed validation

If the backend exposes the SDK in-process, prefer:

- `checkScenario`
- `checkAllScenarios`

Use those checks to validate the recipes against the real database behavior.

This is the preferred path because it runs the actual `up` -> `down` lifecycle close to the database and returns structured validation errors.

### 3.3 - Fallback to signed endpoint validation

If SDK-backed validation is not available but the HTTP Environment Factory is reachable, validate through the endpoint:

1. confirm `discover` works
2. send signed `up` requests with the recipe payload
3. confirm the response is valid
4. send signed `down` requests
5. confirm cleanup succeeds

Use this only when a local SDK-backed check is unavailable.

### 3.4 - Fix recipe or integration gaps

If validation fails:

- fix the recipe if the scenario shape is wrong
- fix small backend integration issues if they prevent validation
- preserve the Step 2 contract while doing so

Common failures:

- unique constraint errors
- missing required fields
- wrong creation order
- incorrect FK wiring
- generated fields accidentally hardcoded
- teardown gaps

Do not claim a true rollback-based dry run unless the backend explicitly implements transaction-based validation. By default, describe this correctly as create-then-clean lifecycle validation.

### 3.5 - Persist approved recipes

Write `autonoma/scenario-recipes.json`.

For each scenario, include:

- scenario name
- validation strategy used
- whether validation passed
- a recipe payload or generation structure
- variable field tokens used by the recipe
- any notes about constraints or cleanup behavior

---

## Phase 4: Verify

### 4.1 - Verify the artifact

Confirm that:

- all three scenarios exist
- each scenario has a validated recipe
- generated tokens in the recipe still match the tokens from `scenarios.md`
- the recorded validation strategy is accurate

### 4.2 - Verify the lifecycle

If you used SDK-backed checks, report the exact success/failure result per scenario.

If you used HTTP endpoint validation, report that:

- `discover` succeeded
- `up` succeeded
- `down` succeeded

for each validated scenario.

### 4.3 - Report to the user

Tell the user:

> "Done! I've validated the Step 2 scenarios against the Environment Factory lifecycle and saved the approved recipes in `autonoma/scenario-recipes.json`.
>
> Validation strategy: [SDK-backed checks / signed endpoint validation]
> Scenarios validated: [list]
> Generated fields preserved: [count]
> Backend fixes made: [summary, or 'none']
>
> Next step: use these validated recipes as the source of truth for later scenario execution and test setup."

---

## Important reminders

- **Assume the Environment Factory already exists.** Step 4 is mainly about validation and recipe approval, not greenfield endpoint implementation.
- **Use Step 2 as the contract.** `discover.json` is the schema source of truth and `scenarios.md` is the planning contract.
- **Prefer SDK-backed validation.** Use `checkScenario` or `checkAllScenarios` whenever the backend exposes them.
- **Generated values must stay generated.** If Step 2 marked a field as variable, do not convert it back into a fixed literal in the recipe.
- **Be precise about cleanup semantics.** Unless the backend explicitly implements transaction rollback, describe validation as `up` followed by `down`, not as a true rollback dry run.
- **Fix small gaps, don't redesign the system.** If validation fails, repair the recipe or a narrow integration issue. Do not rewrite the backend architecture.

</details>
