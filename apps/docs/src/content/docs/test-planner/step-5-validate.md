---
title: "Step 5: Validate Scenario Lifecycle"
description: "Run discover/up/down against every scenario, fix whatever breaks, emit scenario recipes, and upload them to the dashboard."
---

The scenario validator is the **gate** between "endpoint exists" and "tests can be written against it." It drives the full SDK lifecycle against every scenario, iteratively fixes whatever is broken, and records the final, reconciled scenario trees as `scenario-recipes.json` for the Autonoma dashboard.

This step **must pass** before Step 6 (test generation) runs. A PostToolUse validation gate in the plugin blocks test-file writes until the sentinel `autonoma/.endpoint-validated` exists, so you cannot accidentally generate tests against broken scenario data.

## Prerequisites

- `autonoma/entity-audit.md` (output from [Step 2](/test-planner/step-2-entity-audit/))
- `autonoma/scenarios.md` (output from [Step 3](/test-planner/step-3-scenarios/))
- `autonoma/.endpoint-implemented` sentinel (output from [Step 4](/test-planner/step-4-implement/))
- A running dev server that exposes the Environment Factory endpoint
- `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` set in the server's environment

## What this produces

- `autonoma/scenario-recipes.json` — the validated create tree for every scenario, keyed by scenario name, with a `variables` block listing every `{{token}}` placeholder
- `autonoma/.scenario-validation.json` — terminal artifact recording validation status, preflight result, and any edits the agent made to `scenarios.md`
- `autonoma/.endpoint-validated` — sentinel that unlocks Step 6
- Uploaded scenario recipes on the Autonoma dashboard, attached to this generation

## What the agent does

### The iteration loop

For each scenario in `scenarios.md`, the agent runs an HMAC-signed `discover` → `up` → `down` loop against the live endpoint.

- **`discover`** — fetches the schema. Every model in the entity audit must appear under `schema.models`. Every model marked `independently_created: true` must have a factory registered on the handler.
- **`up`** — sends the scenario's create tree. The agent verifies that the response includes a non-empty `auth` block, that every expected record exists in the database (read-only SELECT queries), and that `refsToken` is returned.
- **`down`** — tears down using the signed refs token. The agent verifies that every record created by `up` is gone and that nothing outside the refs was touched.

If a scenario fails, the agent decides whether the **handler** is wrong or the **scenario** is wrong:

| Symptom | Fix |
|---|---|
| Factory missing, FK unresolved, handler crash, auth callback broken | Fix the handler in the backend and retry |
| Scenario references a model that doesn't exist, requires an impossible unique constraint, or depends on a field the schema doesn't have | Edit `scenarios.md` to match reality and retry |

The loop runs up to **5 iterations**. If it still hasn't converged, the agent stops and surfaces the failure — it does not write the validated sentinel.

### Scenario recipes

Once every scenario passes, the agent emits `scenario-recipes.json`. Each recipe is the **exact nested tree** that was proven to work in `up`, plus a `variables` block mapping every `{{token}}` to the concrete value used during validation. The file is validated against `ScenarioRecipesFileSchema` (in `@autonoma/types`) by both the local preflight and the dashboard upload endpoint. Full field-by-field contract (including the `variables` tagged union and all rejection reasons) lives in the [Scenario Recipe Schema reference](/reference/scenario-recipe-schema/). The shape is:

```json
{
  "version": 1,
  "source": {
    "discoverPath": "autonoma/discover.json",
    "scenariosPath": "autonoma/scenarios.md"
  },
  "validationMode": "endpoint-lifecycle",
  "recipes": [
    {
      "name": "standard",
      "description": "Realistic dataset for core flows",
      "create": {
        "Organization": [ { "_alias": "org1", "name": "Acme", "projects": [ { "title": "{{project_title}}" } ] } ]
      },
      "variables": {
        "project_title": { "strategy": "literal", "value": "Launch Campaign" }
      },
      "validation": { "status": "validated", "method": "endpoint-up-down", "phase": "ok", "up_ms": 12, "down_ms": 8 }
    }
  ]
}
```

Required invariants (the upload endpoint rejects otherwise):

- `version` is the integer `1` (not the string `"1.0"`).
- `source` is an object with BOTH `discoverPath` and `scenariosPath` as non-empty strings.
- `validationMode` is `"sdk-check"` or `"endpoint-lifecycle"`.
- `recipes` is an array (not a map) with at least one entry; each entry has `name`, `description`, `create`, and `validation`.
- `variables` values use `strategy: "literal" | "derived" | "faker"`. `derived` additionally requires `source: "testRunId"` and a `format` string. `faker` requires a `generator` id.

### Preflight

Before uploading, the agent runs `preflight_scenario_recipes.py` against the file. Preflight is a deterministic Python check that enforces structural invariants:

- every scenario listed in `scenarios.md` frontmatter appears as a recipe
- every `{{token}}` referenced in a tree is declared in `variables`
- the create tree roots at the scope entity from `discover`
- `variables` values are concrete, not placeholder

If preflight fails, the agent stops — the dashboard never sees a malformed recipe.

### Upload

On success, the plugin orchestrator uploads the recipes to `/v1/setup/setups/:id/scenario-recipe-versions`. The response must be 200 or 201. Upload failures also block Step 6.

## Review checkpoint

After validation completes, review:

- **Scenario edits** — did the agent modify `scenarios.md`? If yes, read the edits carefully. A small edit (correcting a field name) is fine; a large structural change suggests the original scenario design missed something and is worth revisiting before moving on.
- **Auth block** — the `up` response's `auth` block is what tests use to log in. Confirm it contains usable credentials (session cookie, JWT, etc.) for every role the scenarios define.
- **Clean teardown** — the agent verified `down` leaves no orphans. If your schema has triggers or cascade rules that the ORM doesn't know about, this is where you'll catch them.
- **Upload success** — the recipes uploaded successfully and are visible on the Autonoma dashboard for this generation.

## What happens next

Step 6 (E2E Test Generation) consumes `scenarios.md` (possibly edited) as the source of truth for test data. Every `{{token}}` placeholder in the tests corresponds to a variable declared in `scenario-recipes.json`, so the test runner can substitute the real values at execution time.

## Safety

The validator only writes through the SDK endpoint. It never runs INSERT, UPDATE, DELETE, DROP, or TRUNCATE directly, even if validation fails repeatedly. Read-only `SELECT` queries are used for database verification. The SDK's `down` action is the only deletion path, and it only removes what the matching `up` created (verified by the signed refs token).

## The prompt

<details>
<summary>Expand full prompt</summary>

# Scenario Validator: iterative fix loop + reality reconciliation

The Environment Factory endpoint exists (Step 4 wrote `autonoma/.endpoint-implemented`). Your job is to prove it actually works and keep iterating until it does. The E2E test generator (Step 6) is gated on your sentinel — if you do not write `autonoma/.endpoint-validated`, no tests get generated.

## Database safety (absolute)

- ALL writes go through the SDK endpoint only. Never INSERT/UPDATE/DELETE/DROP/TRUNCATE via psql or raw SQL.
- You MAY run SELECT via psql / ORM read queries to verify data.
- The SDK's `down` action deletes only what `up` created (signed refs token).

## Inputs

- `autonoma/entity-audit.md`
- `autonoma/scenarios.md` (may contain mistakes you will correct)
- The handler file created in Step 4
- A running dev server
- `AUTONOMA_SDK_ENDPOINT` and `AUTONOMA_SHARED_SECRET`

## Outputs

- `autonoma/scenario-recipes.json`
- `autonoma/.scenario-validation.json`
- `autonoma/.endpoint-validated`

## The loop

Repeat until all three actions succeed for every scenario OR you exhaust 5 iterations:

1. Fetch protocol docs (first iteration only):

   ```bash
   curl -sSfL "$(cat autonoma/.docs-url)/llms/protocol.txt"
   curl -sSfL "$(cat autonoma/.docs-url)/llms/scenarios.txt"
   curl -sSfL "$(cat autonoma/.docs-url)/llms/test-planner/step-5-validate.txt"
   ```

2. Export working secrets:

   ```bash
   export AUTONOMA_SHARED_SECRET=${AUTONOMA_SHARED_SECRET:-$(openssl rand -hex 32)}
   export AUTONOMA_SIGNING_SECRET=${AUTONOMA_SIGNING_SECRET:-$(openssl rand -hex 32)}
   ```

3. Run `discover` via curl with proper HMAC.
   - Response MUST contain `schema.models`, `schema.edges`, `schema.relations`, `schema.scopeField`.
   - **Coverage check**: every model in `entity-audit.md` MUST appear in `schema.models`.
   - **Factory coverage check**: every model with `independently_created: true` MUST be registered on the handler.
   - **Factory-body integrity check (deterministic, MANDATORY)**: grep the handler for raw DB/ORM writes. Any inline ORM/raw-SQL create inside a factory body for a model marked `independently_created: true` is a FAIL — fix the handler to import and call the audited function and restart.

4. For each scenario in `scenarios.md`:
   1. Build `{action:"up", create:..., testRunId:"<scenario>-<iteration>"}` from the scenario.
   2. HMAC-sign and POST.
   3. On failure, pick one of three paths:
      - **Handler bug** → fix the handler and restart.
      - **Scenario bug** (field does not exist, FK target wrong) → edit `scenarios.md` to match reality and restart. Log the change.
      - **Unfeasible scenario** → REMOVE it from `scenarios.md` with justification. Restart.
   4. On 200, parse `auth`, `refs`, `refsToken`.
      - **Auth check**: `auth` MUST be non-null and contain at least one of `{ cookies, headers, token, user }`.
      - **Refs check**: every top-level model in the `create` tree MUST appear in `refs`.
   5. Verify DB state with a read-only `SELECT` for at least one refs id.
   6. POST `{action:"down", refsToken}`. Expect `{ok:true}`.
   7. Verify the refs rows are gone.

5. After every scenario passes cleanly, emit the scenario recipes.

   Write `autonoma/scenario-recipes.json`:

   ```json
   {
     "version": 1,
     "source": {
       "discoverPath": "autonoma/discover.json",
       "scenariosPath": "autonoma/scenarios.md"
     },
     "validationMode": "endpoint-lifecycle",
     "recipes": [
       {
         "name": "standard",
         "description": "Realistic dataset for core flows",
         "create": {
           "Organization": [{ "_alias": "org1", "name": "Acme Corp" }]
         },
         "variables": {
           "testRunId": { "strategy": "derived", "source": "testRunId", "format": "{testRunId}" }
         },
         "validation": { "status": "validated", "method": "endpoint-up-down", "phase": "ok", "up_ms": 12, "down_ms": 8 }
       }
     ]
   }
   ```

   Rules:
   - Top-level keys MUST be exactly `version`, `source`, `validationMode`, `recipes`
   - `version` must be integer `1`
   - `source` MUST be an object with BOTH `discoverPath` (path to `autonoma/discover.json`) and `scenariosPath` (path to `autonoma/scenarios.md`) as non-empty strings. The dashboard `/v1/setup/setups/:id/scenario-recipe-versions` endpoint will reject the upload if either is missing.
   - `validationMode` must be `sdk-check` or `endpoint-lifecycle`
   - `recipes` MUST include `standard`, `empty`, and `large`
   - Every recipe MUST contain `name`, `description`, `create`, and `validation`
   - `create` MUST use a nested tree rooted at the scope entity. Do NOT use flat top-level model keys connected only by `_ref`.
   - If `create` contains `{{token}}` placeholders, include a `variables` object. Every `{{token}}` in `create` must match a key in `variables`; every key in `variables` must be used in `create`.

6. Run preflight on the emitted recipes:

   ```bash
   python3 "$(cat /tmp/autonoma-plugin-root)/hooks/preflight_scenario_recipes.py" \
     autonoma/scenario-recipes.json
   ```

   This resolves tokenized payloads and re-runs signed up/down against the live endpoint. If preflight exits non-zero, fix the failing recipe and re-run.

7. Write `autonoma/.scenario-validation.json`:

   ```json
   {
     "status": "ok",
     "preflightPassed": true,
     "smokeTestPassed": true,
     "validatedScenarios": ["standard", "empty", "large"],
     "failedScenarios": [],
     "blockingIssues": [],
     "recipePath": "autonoma/scenario-recipes.json",
     "validationMode": "endpoint-lifecycle",
     "endpointUrl": "http://localhost:3000/api/autonoma"
   }
   ```

8. Write the sentinel `autonoma/.endpoint-validated` via the `Write` tool (NOT `touch`) with a short plain-text report.

## Iteration discipline

- One handler fix per iteration, then re-run everything.
- If the same scenario fails twice in a row with the same error, the scenario itself is probably wrong — prefer editing `scenarios.md`.
- If you have edited `scenarios.md`, re-read it from disk after every edit.

## When you hit the 5-iteration cap

STOP and write a clear failure report. Do NOT write `.endpoint-validated`. Include the last failing curl body + response, which scenario(s) failed, and which handler file + line range is most likely at fault. The orchestrator surfaces this to the user.

## scenarios.md reconciliation rules

Preserve the frontmatter shape (the validator hook checks it). Allowed:
- Drop a scenario entirely (decrement `scenario_count`, update the `scenarios` summary).
- Remove/rename fields on a model to match what `discover` reports.
- Adjust FK aliases so they reference models that actually exist.
- Flatten cross-branch references that the handler cannot resolve.

Disallowed: silently changing a scenario's intent (e.g. renaming "admin with one project" to "user with one project" without reflecting that in the description).

</details>
