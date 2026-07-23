---
name: scenarios
description: "Read this skill when working on scenario provisioning, the @autonoma/scenario package, the customer SDK endpoint contract, scenario recipe ingestion, scenario instance lifecycle, or any code that reads/writes the Scenario / ScenarioInstance / ScenarioRecipeVersion / WebhookCall tables."
---

# Scenarios

## What a scenario is

A **scenario** is a named, versioned description of an application state that a test depends on - e.g. "logged-in admin with three projects and one open invoice." Customers author scenarios in their own repo (alongside their app code) using the Autonoma SDK; the planner plugin compiles each one into a recipe (a JSON entity-creation payload plus a set of resolved-at-runtime variables) and uploads them to Autonoma.

At test time we provision a fresh **scenario instance** per run by calling the customer's SDK endpoint with the recipe. The customer's SDK code interprets the recipe, creates the entities in their database, and returns auth tokens / refs we hand back to the test runner. After the test, we call the same endpoint with `action: "down"` and the customer cleans up.

Scenarios solve two problems:

1. **Test isolation.** Each run gets its own data, generated deterministically from the run id, so concurrent runs never collide.
2. **Customer-owned data shape.** We never touch the customer's database directly. They control what "logged-in admin with three projects" means; we just send the recipe.

## The endpoint contract

The customer deploys our SDK as part of their backend. The SDK exposes a single HTTP endpoint that handles three actions:

- **`discover`** - returns the schema of available models so we know what types of entities the app supports. Called during onboarding (to validate a webhook URL + signing secret) and on demand from the API.
- **`up`** - takes a `create` payload (the recipe with variables resolved) plus a `testRunId`, builds the entities, and returns `{ auth, refs, refsToken, expiresInSeconds?, metadata? }` so the test can authenticate.
- **`down`** - takes the `refs` and `refsToken` from a prior `up` and tears down the instance.

All requests are POSTs with an `x-signature` HMAC-SHA256 header computed over the body using a per-application shared secret. The secret is stored encrypted (AES-256-GCM) at rest. Responses are zod-validated. Each call is a single attempt - there are no retries; a network failure, non-2xx status, or validation failure surfaces as a thrown error for the caller to handle.

Defaults: `discover`/`up` use a 90s timeout; `down` uses 60s.

## Database models

| Table                       | Role                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Application`               | Holds `signingSecretEnc` (the encrypted HMAC secret) and identifies the tenant.                                                 |
| `BranchDeployment`          | Holds the SDK endpoint URL and any custom request headers. Columns are named `webhookUrl` / `webhookHeaders` for legacy reasons - the package and code consistently refer to "SDK" instead. |
| `Scenario`                  | One row per named scenario per application. Tracks the active recipe version, last-seen fingerprint, and disabled flag.        |
| `ScenarioRecipeVersion`     | Versioned recipe payload (`fixtureJson`) keyed by `(scenarioId, snapshotId)`. Each upload from the planner creates new rows. |
| `ScenarioSchemaSnapshot`    | Per-application structure summary keyed by `(applicationId, snapshotId)`, derived from the recipes' shape (model + field + ref graph). Used to detect breaking schema changes. |
| `ScenarioInstance`          | One row per test-run provisioning. State machine: `REQUESTED -> UP_SUCCESS \| UP_FAILED -> DOWN_SUCCESS \| DOWN_FAILED`. Stores `auth`, `refs`, `refsToken`, `expiresAt`, `lastError`, `resolvedVariables`. |
| `WebhookCall`               | Log of every SDK endpoint call (request body, response body, status, duration, error). Used in the debugging UX. Table name kept for legacy reasons. |
| `Run.scenarioInstanceId`, `TestGeneration.scenarioInstanceId` | Foreign-key link from a run/generation to its provisioned instance. |

`scenarioId` on `TestPlan` / `Run.assignment.plan` says which scenario a test wants. `scenarioInstanceId` on the run/generation says which provisioned instance it actually got.

## Recipe shape (what the customer uploads)

A recipe file (`autonoma/scenario-recipes.json`) is a list of recipes, each containing:

- `name`, `description` - human-readable identity. Names are unique per application.
- `create` - the entity-creation payload, an object keyed by model name with arrays of entities. Entities can use `_alias: "foo"` to be referenced via `{ "_ref": "foo" }` from other entities (foreign keys).
- `variables` (optional) - tokens used inside `create` like `{{owner_email}}`. Each variable has a strategy:
  - `literal` - fixed value.
  - `derived` - templated from `testRunId` (e.g. `format: "owner+{testRunId}@example.com"`).
  - `faker` - one of a small set of seeded generators (`person.firstName`, `internet.email`, `company.name`, `lorem.words`, etc.). Output is deterministic per `(testRunId, tokenName)` pair.
- `validation` - metadata about whether the planner managed to dry-run the recipe before uploading.

When loading a recipe for a run, we collect every `{{token}}` in `create`, validate that every used token has a definition (and every defined token is used), resolve them, and substitute them in. Unresolved tokens after substitution are an error.

The structure summary stored in `scenarioSchemaSnapshot.structureJson` is a sorted, normalized derivation: for each model name, the union of fields seen across all recipes plus the `_ref` graph. It's fingerprinted so we can cheaply detect when a recipe upload represents a real schema change.

## Lifecycle

1. **Setup / recipe ingestion.** The customer's planner plugin uploads `scenario-recipes.json` to `POST /setups/:id/scenario-recipe-versions`. The application-setup service writes recipes for the active snapshot (and replicates them to the pending snapshot if there is one, so a snapshot under construction stays in sync).

2. **Onboarding validation.** When a customer enters their SDK URL + signing secret, the onboarding state machine calls `discover` *with the caller-supplied config* before persisting it. A failed call leaves the URL unsaved and surfaces a typed error so the user can correct it. After persistence, the user can run a dry-run scenario from onboarding (`up` then `down`).

3. **Test-time provisioning.** The scenario-up job (run before each test run / generation) resolves the recipe, generates a UUID, creates a `scenarioInstance` row in `REQUESTED`, links it to the run/generation, calls `up`, and updates the row with the response. On failure it transitions to `UP_FAILED` and the test fails fast.

4. **Teardown.** After the test, the scenario-down job calls `down` with the stored `refs` / `refsToken` and updates the row. Already-torn-down instances are short-circuited so re-invocations are idempotent.

5. **Expiration safety net.** Each instance has an `expiresAt` (defaulting to 2h, overridable via the `up` response's `expiresInSeconds`). If the customer's `down` is never called, the instance is at least flagged as expired.

## Package layout (`@autonoma/scenario`)

The package is structured around a clean separation of concerns:

- **`SdkClient`** - pure HMAC-signed HTTP client. No Prisma. Constructible from raw config (URL, secret, headers) so dependent code can be tested without spinning up Postgres. Single attempt per call, no retries. Methods: `discover`, `up`, `down`.

- **`SdkCallRecorder` interface** + **`DbSdkCallRecorder`** implementation - per-call observability seam. The interface is single-method (`record(event)`) and the contract is "never rejects" (recorder owns its own error handling). Production wiring uses `DbSdkCallRecorder` to land each call in `WebhookCall`. Tests pass `NOOP_RECORDER` or an in-memory stub.

- **`EncryptionHelper`** - AES-256-GCM wrapper around the shared signing secret. Validates the master key length at construction so misconfiguration surfaces at API boot, not on the first onboarding request.

- **`ScenarioRecipeStore`** - DB layer for recipe ingestion (`replaceScenarioRecipes`) and per-run lookup (`loadRecipePayload`). Transactional ingestion: upserts the schema snapshot, replaces recipe versions for the snapshot, retargets the active-recipe pointer, disables names no longer present.

- **A pure recipe resolver module** - variable substitution, faker generators, structure extraction. No I/O. Trivially unit-testable. Used by `ScenarioRecipeStore` and reachable independently if other code ever needs to resolve a recipe outside the DB path.

- **`ScenarioManager`** - DB-backed orchestrator that wires the client, recorder, encryption, and recipe store together. Public methods: `discover(applicationId, deploymentId, options?)`, `up(subject, scenarioId, opts?)`, `down(scenarioInstanceId, options?)`. Recipe ingestion is *not* on the manager - callers go through `ScenarioRecipeStore` directly.

- **`ScenarioSubject` interface** + `GenerationSubject` / `RunSubject` - the seam that decouples `ScenarioManager.up` from "what entity needs the scenario." A subject only has to:
  - `resolveDeployment()` - return `{ applicationId, deploymentId }`.
  - `linkInstance?(instanceId)` (optional) - persist the instance id back onto the entity, e.g. `run.scenarioInstanceId = ...`.

  The SDK config lookup (URL, signing secret, headers) is centralized inside the manager - subjects don't reach into application/deployment rows directly. This is what makes the dry-run subject in onboarding trivially small (no `linkInstance` to no-op out).

## Where the package is called from

- **`ApplicationSetupService`** (in `apps/api`) - calls `ScenarioRecipeStore.replaceScenarioRecipes` when the planner plugin uploads recipes. Replicates to the pending snapshot if there is one.

- **Onboarding state machine** (in `apps/api`) - the `webhook_configuring` state constructs an `SdkClient` directly with the caller-supplied URL/secret to validate before persistence. Once persisted, the `discovered` and `dry_run_passed` states call `ScenarioManager.up` + `down` for dry runs through a `DryRunSubject` (which implements `resolveDeployment` only).

- **`ScenariosService`** (tRPC, in `apps/api`) - exposes `discover` and a manual dry-run for the scenarios UI.

- **The scenario-up / scenario-down worker activities** (in `apps/workers/general/src/activities/scenario`) - the production path, run in-process as Temporal activities. Each test run / generation resolves `(scenarioId, snapshotId)` from the run or generation row, builds the appropriate `ScenarioSubject`, and calls `ScenarioManager.up` / `down`.

## Conventions / gotchas

- **Database column names still say "webhook"** (`webhookUrl`, `webhookHeaders`, `webhookCall`, `WebhookAction` enum). The code surface uses "SDK" everywhere because that's the accurate term - we're calling the customer's deployed Autonoma SDK, not a generic webhook. The DB rename is a separate two-step migration (data + drop) that hasn't shipped. Translate at the boundary; don't propagate "webhook" terminology into new code.

- **No retries at the SDK-client level.** Each `SdkClient` call is a single attempt. A network failure, non-2xx status, or schema validation failure throws immediately - the caller decides what to do. Retrying a malformed response would just fail the same way, and the up/down callers are the right place for any higher-level retry policy. The one such policy that exists is **cold-start retry**: `ScenarioManager.up` takes an opt-in `coldStartRetry` flag (see `cold-start-retry.ts`) that retries ONLY the infra signature of a scaled-to-zero preview waking up - a 502/503/504 or a connection refused/reset, bounded to ~30s. It never retries a real 4xx/5xx, a bad response, or a timeout. The onboarding dry-run (`ScenariosService.dryRun`) opts in; the production scenario-up path does not yet (a deliberate one-line follow-up). When a dry-run is still cold after the retry, `dryRun` returns `coldStart: true` with a plain-English message (it runs `isColdStartMessage` over the persisted `lastError`) instead of the raw "HTTP 503: ... Unexpected token" text, so the caller can tell "preview is warming, retry" apart from a real recipe failure.

- **The recorder must not throw.** `SdkClient` does not defend against recorder failures. If you write a new `SdkCallRecorder` implementation, catch and log your own errors internally. Production's `DbSdkCallRecorder` does exactly this.

- **`testRunId` is the scenario instance UUID**, not a separate concept. We mint it before the `up` call so the recipe can use it as a seed for `derived` and `faker` variables, giving deterministic resolved values for a given instance.

- **Recipe ingestion replaces, doesn't accumulate.** Re-uploading recipes for the same snapshot deletes prior versions for that snapshot in the same transaction. Different snapshots get independent recipe-version rows.

- **Names not in the latest upload get disabled, not deleted.** Scenarios persist (with `isDisabled = true`) so historical references and instance rows stay valid.
