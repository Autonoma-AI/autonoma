---
title: "Step 4: Implement Environment Factory"
description: "Install the Autonoma SDK in your backend, configure the handler, and register a factory for every model with dedicated creation code. Validation of the full up/down lifecycle happens in Step 5."
---

The Environment Factory implementer takes your `scenarios.md` and `entity-audit.md` and sets up the Environment Factory endpoint using the Autonoma SDK. It installs the SDK packages and registers a factory for **every model that has dedicated creation code** (identified in the audit), so test data created during `up` flows through the same business logic your app uses in production.

This step writes code and runs a `discover` smoke test plus a factory-integrity check. It does **not** run the full `up`/`down` lifecycle — that happens in [Step 5](/test-planner/step-5-validate/), which iteratively validates every scenario, fixes what breaks, and uploads the reconciled recipes.

## Prerequisites

- `autonoma/entity-audit.md` must exist (output from [Step 2](/test-planner/step-2-entity-audit/))
- `autonoma/scenarios.md` must exist (output from [Step 3](/test-planner/step-3-scenarios/))
- Your application's **backend codebase** must be open in the workspace. The agent will locate it by scanning for manifest files (`package.json`, `pyproject.toml`, `go.mod`, etc.) — it does NOT hardcode the directory name `backend/`, so non-standard names like `core-app-backend/`, `apps/api/`, or `services/core/` are fine. If the backend is in a separate repo, the agent will generate a portable prompt instead of scaffolding a sidecar.
- A backend with a working DB layer (Prisma, Drizzle, SQLAlchemy, Ecto, etc.). The SDK does not require a specific ORM — your factories call whatever services / repositories your app already has.
- Node.js 18+ (TS) or Python 3.11+

## Generating the secrets

The implementation requires **two separate secrets** with different purposes:

```bash
# 1. Shared secret — you AND Autonoma both know this one.
#    Autonoma uses it to sign every request (HMAC-SHA256).
#    Your endpoint uses it to verify the signature.
#    You paste this into the Autonoma dashboard when connecting your app.
openssl rand -hex 32
# Example output: 4a8f...  → set as AUTONOMA_SHARED_SECRET

# 2. Signing secret — only YOUR backend knows this one.
#    Used to sign the refsToken during up and verify during down.
#    Autonoma stores the token opaquely — it cannot read or modify it.
openssl rand -hex 32
# Example output: 7b3d...  → set as AUTONOMA_SIGNING_SECRET
```

These must be **different values**. The SDK throws an error if they match. For more details on the security model, see the [Security Model](/guides/environment-factory/#security-model) in the Environment Factory Guide.

## What this produces

- The Autonoma SDK packages installed in your backend
- A working endpoint handler using `createHandler()` / `createExpressHandler()` / `createHonoHandler()` / `createNodeHandler()` (TypeScript) or `create_fastapi_handler()` / `create_flask_handler()` / `create_django_handler()` (Python) with:
  - `scopeField` (e.g. `"organizationId"`) plus the two secrets (`sharedSecret`, `signingSecret`) on `HandlerConfig`
  - A factory registered for **every model in `entity-audit.md`**. Each factory declares an `inputSchema` (Zod) / `input_model` (Pydantic) plus `create` / `teardown` functions that call your real services
  - Auth callback that creates real, working credentials
- Validated scenario lifecycle — proof that `up` creates the correct data and `down` cleans it up

## Review checkpoint

Before writing any code, the agent will present a full implementation plan. This is a standard plan-mode approval gate — review it before the agent proceeds.

**What to check:**

- **SDK packages** — correct packages for your framework (e.g., `@autonoma-ai/sdk` + `@autonoma-ai/server-express` + `zod`, or `autonoma-ai` + the matching `autonoma_*` server adapter)
- **Endpoint location** — fits your existing route structure
- **Factories** — **every** model in `entity-audit.md` has a factory registered. Models marked `independently_created: true` call the audit's identified `creation_file` / `creation_function`; models marked `independently_created: false` still need a factory, but it can wrap a thin repository call. There is no SQL fallback anymore.
- **Auth strategy** — correctly identifies how your app authenticates users. Session cookies, JWT, or credentials.
- **Environment variables** — `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` are both listed

:::tip
If you're unsure about the protocol details, read the [Environment Factory Guide](/guides/environment-factory/) before reviewing the plan.
:::

## The prompt

<details>
<summary>Expand full prompt</summary>

# Environment Factory: SDK Setup & Validation

You are a backend engineer. Your job is to install the Autonoma SDK, configure the handler with factories, and validate the scenario lifecycle for this application.

---

## CRITICAL: Database Safety

You may be connected to a production database. Follow these rules absolutely:

- **ALL writes go through the SDK endpoint only.** The SDK has production guards, HMAC authentication, and signed refs tokens that prevent accidental damage.
- **You MAY read from the database** using `psql`, database GUIs, or ORM queries for verification purposes (SELECT only).
- **You MUST NEVER** run INSERT, UPDATE, DELETE, DROP, or TRUNCATE directly via psql, raw SQL, ORM write methods, or any other path outside the SDK endpoint.
- **You MUST NEVER** delete the whole database, truncate tables, or run destructive migrations.
- The SDK's `down` action only deletes records that `up` created, verified by a cryptographically signed token. This is the only safe deletion path.

---

## HARD CONTRACT — READ FIRST

You MUST NOT:
- Create a new server, app, or sidecar process. No new `FastAPI()` / `express()` / `Flask()` / standalone `main.py` / `start-*.py` / `main.go` launcher at the repo root.
- Install a Python SDK into a TypeScript backend (or vice versa). The SDK language MUST match the backend's language.
- Scaffold files at the repo root when an existing backend directory exists — even if that directory is named `core-app-backend/`, `apps/api/`, `services/core/`, or any other non-standard name.
- Pick an SDK before you have located and identified the backend in Phase 1.

If you cannot locate a backend, or the backend's language has no matching Autonoma SDK, **STOP and ask the user**. Never fall back to a sidecar.

---

## Phase 0: Locate prerequisites

### 0.1 — Find scenarios.md

1. Check for `autonoma/scenarios.md` at the workspace root.
2. If not found, search broadly for `scenarios.md` anywhere in the workspace.

If not found, tell the user:

> "I need `scenarios.md` to implement the Environment Factory. Please run the Scenario Generator (Step 2) first, then come back and run this prompt."

Do not proceed without it.

### 0.2 — Read the Environment Factory documentation

Fetch the Autonoma documentation to understand the current SDK setup:

1. Fetch `https://docs.agent.autonoma.app/llms.txt` to get the documentation index
2. Read the **Environment Factory Guide** — understand the SDK packages, factory registration with `inputSchema` / `input_model`, the `scopeField` on `HandlerConfig`, auth callback patterns, and the create tree format
3. Read the **framework example** that matches this project's stack if one exists

**Always read the live docs.** The SDK may have been updated since this prompt was written.

### 0.3 — Read scenarios.md

Read `scenarios.md` fully. Identify:

- The scenario names and their create trees
- Every model referenced in the create trees
- Cross-branch references (`_alias` / `_ref`)
- Fields that use `testRunId` for uniqueness

---

## Phase 1: Explore the codebase

This exploration builds your understanding of the project — the same understanding that determines factory registration and auth implementation.

### 1.1 — Locate the backend and detect its language (do this BEFORE anything else in Phase 1)

Real projects use many directory conventions. Do NOT hardcode `backend/`. Enumerate candidates with Glob:

- `backend/`, `server/`, `api/`, `service/`, `services/`
- `*-backend/`, `*-api/`, `*-server/`, `core-*/`, `app-*/`, `core-app-backend/`
- Monorepo layouts: `apps/*`, `packages/*`, `services/*`
- Single-repo backends at the workspace root

Detect language per candidate from its manifest file — this determines which Autonoma SDK you install:

| Manifest found | Language | SDK package |
|----------------|----------|-------------|
| `package.json` | TypeScript/JavaScript | `@autonoma-ai/sdk` |
| `pyproject.toml` / `requirements.txt` / `Pipfile` | Python | [`autonoma-ai`](https://pypi.org/project/autonoma-ai/) |
| `go.mod` | Go | `github.com/autonoma-ai/autonoma-sdk-go` |
| `Cargo.toml` | Rust | `autonoma` crate |
| `pom.xml` / `build.gradle` | Java | `ai.autonoma:autonoma-sdk` |
| `Gemfile` / `*.gemspec` | Ruby | `autonoma` gem |
| `composer.json` | PHP | `autonoma/sdk` |
| `mix.exs` | Elixir | `autonoma` hex package |

**Pick exactly one backend.** If multiple plausible candidates exist, STOP and ask the user. Do not guess. Do not implement in more than one.

**State your finding back to the user before writing any code:**

> "I found the backend at `<path>` (language: `<lang>`, framework: `<framework>`). I'll implement the endpoint there using the `<sdk-package>` SDK. Is that the right location?"

Wait for confirmation.

**If no candidate matches a supported SDK language**: STOP and ask the user. Do NOT build a standalone Python (or any) sidecar as a workaround. Do NOT install a language SDK that doesn't match the backend.

**If the backend is in a separate repo not open in this workspace**: generate a self-contained prompt the user can run in the backend workspace, including the full `scenarios.md` content, a link to the live docs, and all implementation instructions. Do not create a sidecar in the current workspace.

### 1.2 — Understand the stack

Identify:

- **Framework**: Next.js, Express, Hono, FastAPI, Flask, Django, etc.
- **DB layer**: Whatever ORM/repository pattern the app already uses — your factories will call those services directly. The SDK does not need a connection.
- **Auth mechanism**: How users log in (session cookies, JWT, OAuth, Better Auth, Lucia, etc.)
- **Existing route patterns**: How other endpoints are structured

### 1.3 — Read entity-audit.md

Read `autonoma/entity-audit.md` and parse the frontmatter. The audit tells you exactly which models to wire up:

- Every model in the audit gets a factory. The SDK is factory-driven: there is no SQL fallback. Every factory must declare an `inputSchema` (Zod) / `input_model` (Pydantic) so the SDK can describe the model to the dashboard and validate the create payload before invoking your code.
- Models with `independently_created: true` get a factory that calls the identified `creation_file` / `creation_function`.
- Models with `independently_created: false` still need a factory, but it can be a thin repository call (`db.tag.create({...})` / `repo.tag.create(...)`) since there's no shared business logic to preserve.

The audit's `side_effects` field is informational — it helps you understand what each factory will preserve.

### 1.4 — Understand auth creation

Find the code path that creates sessions or tokens for users. Search for `createSession`, `jwt.sign`, `lucia`, `better-auth`, `iron-session`, or similar. You need to replicate this in the auth callback.

---

## Phase 2: Plan — go into plan mode

Present a complete implementation plan:

```
## Implementation Plan

### SDK packages to install
[Exact packages: `@autonoma-ai/sdk` + `@autonoma-ai/server-<framework>` + `zod` (TS), or `autonoma-ai` (Python). No ORM-specific package — factories use whatever client the app already has.]

### Endpoint location
[Exact file path]

### Scope field
[e.g., organizationId — explain why]

### Environment variables
- `AUTONOMA_SHARED_SECRET` — shared with Autonoma for HMAC request verification
- `AUTONOMA_SIGNING_SECRET` — private, for signing refs tokens

### Factories to register (from entity-audit.md)
For every model the audit lists, register a factory. Each one declares:
- `inputSchema` (Zod) / `input_model` (Pydantic): every dashboard-supplied field, with the right type. Drives discover.
- `create`: invokes the audit's `creation_file` / `creation_function` for `independently_created: true`, or a thin repository call for `independently_created: false`.
- `teardown`: optional but recommended — invoked during `down` to remove what `up` created.

For every `independently_created: true` row, name the function the factory calls and the side effects observed in the audit. For `independently_created: false`, name the table the factory writes to.

### Auth callback strategy
[How sessions/tokens are created — specific code path in the app]
```

**Wait for user approval before proceeding.**

---

## Phase 3: Implement

### 2.5 — Research pass (MANDATORY before writing any factory)

Post-mortems of past runs show a consistent failure mode: the agent makes **one bad decision and applies it uniformly to every model**. The research pass prevents this by forcing a per-model pause and a documented decision before any handler code is written.

Emit `autonoma/.factory-plan.md` with one row per `independently_created: true` model:

```
| Model | Audit function | File opened? | Import path | DI dependencies observed | Decision (Branch 1/2/3) | Notes |
|-------|----------------|--------------|-------------|--------------------------|-------------------------|-------|
```

Column rules:

- **File opened?** — "yes, lines X-Y" or "no, why". If "no", you MUST NOT proceed — you cannot pick Branch 1 vs Branch 2 without reading the source.
- **Import path** — the exact `import ... from "..."` the handler will use. For Branch 1 rows, this is the *new* export you will create during extraction, not the current inline location.
- **DI dependencies observed** — every constructor arg or closed-over variable the function uses (DB client, logger, event bus, Temporal client, analytics client, etc.). The factory has no `ctx.executor` to lean on; it imports the same DB client / repository singletons the rest of the app uses. Listing every dependency makes any silent give-up visible.
- **Decision** — Branch 1 (extract inline → export → call), Branch 2 (import existing export → call), or Branch 3 (`independently_created: false`, plain repository call is fine). "Inline ORM in production code path" is NOT a valid value for Branches 1 or 2.

#### Cross-codebase DI discovery

Run these greps against the backend BEFORE filling the table:

```bash
# Find how each service is actually constructed in production code.
grep -rnE "new ${ServiceName}\(" apps/ --include='*.ts' --include='*.tsx' | head -20
# Find exported singletons and module-level instances.
grep -rnE "^(export )?(const|let) [a-zA-Z]+ = new " apps/ --include='*.ts' | head -40
# Find composition root candidates.
grep -rnlE "(container|registry|services/index|app\.module)" apps/ | head
```

Use the results to fill "DI dependencies observed" honestly. If a service needs `logger, eventBus, temporal, analytics` and you can't find where the app wires them, STOP and ask the user — do NOT fall back to raw ORM.

#### Hook-level enforcement

When you write `autonoma/.endpoint-implemented` at the end of this step, the plugin's validator hook parses `entity-audit.md`, opens the handler you named in the sentinel body, and blocks the write if any factory for a `independently_created: true` model contains an inline ORM write (`prisma.<m>.create`, `db.<m>.create`, `tx.insert(<m>Table)`, etc.) or if any such model has no factory at all. The agent's self-policed Step A–D check is backed up by this mechanical gate — if you try to ship the anti-pattern, the sentinel write fails with an itemised list of violations and you must fix them before advancing.

---

### 3.0 — Per-model decision tree (run this BEFORE writing any factory)

For every model with `independently_created: true` in `autonoma/entity-audit.md`, walk this tree in order. There is no "give up and use `db.<model>.create()`" escape hatch — `db.<model>.create()` inside a factory body for a `independently_created: true` model is NEVER acceptable.

**Branch 1 — `needs_extraction: true`.** The creation logic is inline in a route handler, a framework hook (Better Auth `databaseHooks`, NextAuth callbacks, Express closures), or an anonymous closure. Extract it first:

1. Move the inline block into a new **named, exported function** in a nearby module (`*.service.ts`, `*.repository.ts`, `create-<model>.ts`, or an existing service). Take a plain input object (no `req`/`res`/`ctx`), return the created record, preserve every side effect the inline block had.
2. Replace the inline block with a call to the new function. Real HTTP callers' behavior must stay identical. Run typecheck/tests.
3. Update `autonoma/entity-audit.md` in-place: add an `extracted_to: <new-path>` field pointing at the file you created, and keep `creation_file`, `creation_function`, and `needs_extraction: true` exactly as Step 2 recorded them. The fidelity rubric's framework-hook carve-out (Criterion 1) relies on those fields remaining intact so it can score the factory against the extracted helper rather than the un-callable hook.
4. Import the new function in the factory.

If extraction is genuinely impossible (inline block inseparable from `req`/`res`, or generated code), STOP and ask the user. Do NOT fall back to raw ORM.

Concrete example — Better Auth `databaseHooks`: if the audit flags `User` with `needs_extraction: true` pointing at `src/auth.ts#buildAuth (databaseHooks.user.create)`, the closure body writes `db.user.create`, then `ensureOrgMembership`, then provisions a `BillingCustomer`. Calling `db.user.create()` in the factory silently skips every sibling row. Extract the closure into `export async function createUserWithOnboarding(input)`, call it from the hook (production still works), update the audit, then import it in the factory.

**Branch 2 — `independently_created: true`, no `needs_extraction`.** Import and call the named export. See the DI playbook below for how to invoke it.

**Branch 3 — `independently_created: false`.** Register a factory whose `create` is a thin repository / ORM call. There is no SQL fallback.

### 3.0.1 — DI / constructor-injection playbook

Factories receive `(data, ctx)` where `data` is the value parsed by `inputSchema` / `input_model`. The DB client/transaction is whatever singleton your app already exports — import it directly. Walk this list in order; first match wins:

1. **Top-level exported function** — `import { createX } from "..."; return createX(data);`. Simplest case.
2. **Static method** — `return XService.create(data, db);` where `db` is the app's exported DB client.
3. **Instance method, needs only a DB client** — `const svc = new XService(db); return svc.create(data);`.
4. **Instance method, needs more dependencies (logger, event bus, config, clients)** — find the app's composition root (DI container, `container.ts`, `app.module.ts`, `services/index.ts`). Either import the already-constructed singleton (`import { userService } from "@/services"`) or rebuild the service the way the composition root does, importing real singletons for everything (DB client, logger, event bus, temporal client). Do not invent mocks.
5. **Impossible** — STOP and ask the user. Do NOT inline ORM writes that bypass production logic.

Never mock, stub, or fake a dependency. The factory must exercise real code.

### 3.0.2 — External side effects policy

Audited creation functions often perform side effects beyond the DB row: Temporal workflows, GitHub/Stripe/Slack APIs, emails, analytics, LLMs. Your goal is **correct DB state, not production-grade external delivery**. Preserve every DB write (including writes to sibling tables done by ORM hooks, framework hooks, triggers). Order of preference:

1. **Call the real function with real side effects** if the test environment has sandbox keys / local Temporal / mocked SDKs wired.
2. **Use the app's existing test-mode toggle** (`NODE_ENV=test`, `DISABLE_WORKFLOWS=1`, feature flag, null-object client).
3. **Wrap external-only calls in try/catch** inside the real function (not inside a rewritten factory body) — only for calls whose failure does not affect DB state under test.
4. **Reimplement the DB writes inline.** NEVER. If you're typing `db.<other_model>.create` inside a factory to replicate what a hook would have done, the function wasn't truly called — you re-wrote it. Go back to option 1 or 2, or ask the user.

You are NOT allowed to skip: password hashing, slug generation, normalization (pure CPU inside the creation function), DB writes performed by ORM/framework hooks on the created model (e.g. Better Auth's `databaseHooks.user.create` writing Organization/Member/BillingCustomer), or writes to sibling tables the creation function itself performs (e.g. `createProject` writing a default Folder).

### 3.1 — Install SDK packages

TypeScript:

```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/server-[framework] zod
```

Python:

```bash
pip install autonoma-ai
```

### 3.2 — Create the endpoint handler

Write a single handler file that:
1. Sets `scopeField: "<your scope field>"` plus the two secrets on the handler config. There is no `executor` field anymore.
2. Registers a factory for **every** model in `entity-audit.md`. Each factory:
   - Declares an `inputSchema` (Zod) / `input_model` (Pydantic) covering every field the dashboard sends. The SDK reads it for `discover` and validates payloads through it before invoking `create`.
   - For `independently_created: true`: imports the function from the audit's `creation_file` and calls it inside `create`. **Never reimplement the creation logic with an inline ORM call** (see WRONG/RIGHT example below). For methods on a class, instantiate the class using the app's exported DB client.
   - For `independently_created: false`: makes a thin repository / ORM call from inside `create`.
   - Optionally declares a `teardown` to remove the record during `down`.
3. Implements the auth callback using the app's real session/token creation.
4. Passes both secrets from environment variables.

Follow the project's existing code patterns — import style, file organization, error handling.

### 3.3 — Register the route

Add the endpoint to the app's routing (e.g., `app.post('/api/autonoma', handler)`).

### 3.4 — Set up environment variables

Add `AUTONOMA_SHARED_SECRET` and `AUTONOMA_SIGNING_SECRET` to `.env` (or equivalent). If `.env.example` exists, add placeholders there too.

---

### 3.5 — The trap: inline ORM calls inside factories

The most common mistake is writing `db.x.create({...})` inside a factory because calling the real function is inconvenient (constructor args, DI). That silently bypasses every piece of business logic the user has — or will add — and makes the scenario data diverge from what the app itself would produce.

```ts
// entity-audit.md: creation_function = OnboardingManager.getState
// WRONG — inline ORM, bypasses OnboardingManager entirely
OnboardingState: defineFactory({
  inputSchema: z.object({ applicationId: z.string() }),
  create: async (data) => {
    return db.onboardingState.create({ data: { applicationId: data.applicationId, step: "welcome" } });
  },
}),

// RIGHT — import the real DB client, instantiate the class, call the real method.
// `data` is inferred from `inputSchema` — no z.infer<...> annotation needed.
import { db } from "@/db";
import { OnboardingManager } from "@/lib/onboarding-manager";

OnboardingState: defineFactory({
  inputSchema: z.object({ applicationId: z.string() }),
  create: async (data) => {
    const manager = new OnboardingManager(db);
    return manager.getState(data.applicationId);
  },
}),
```

The factory imports the same `db` (or `prisma`/`drizzle`/`session`) singleton the rest of the app uses. The SDK does not own a connection — your factory writes through whatever path your app's services normally take.

`defineFactory` is generic over its `inputSchema` and optional `refSchema`, so `data` and (when set) `record` are typed automatically. Add `refSchema: z.object({ id: z.string() })` whenever you also write a `teardown` and want a typed record.

---

## Phase 4: Smoke test and factory-integrity check

This phase proves the handler was wired correctly. It does **not** run the full `up`/`down` lifecycle — that is Step 5's job.

### 4.1 — Start the dev server

Check if it's already running. If not, start it.

### 4.2 — Test discover

```bash
BODY='{"action":"discover"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$AUTONOMA_SHARED_SECRET" | sed 's/.*= //')
curl -s -X POST http://localhost:PORT/api/autonoma \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIG" \
  -d "$BODY" | python3 -m json.tool
```

**Expected**: JSON with `schema` containing `models`, `edges`, `relations`, `scopeField`. Every model from `entity-audit.md` must appear under `schema.models`. `edges` and `relations` are emitted as empty arrays — the dashboard accepts that, and the `_alias`/`_ref` graph in the create payload carries equivalent dependency information at request time.

### 4.3 — Factory-integrity check

Before completing this step, prove deterministically that every factory you registered actually calls the audit's `creation_function`:

1. Re-read `entity-audit.md`. List every model with `independently_created: true` and its `creation_file` / `creation_function`. If any entry still has `needs_extraction: true`, make sure it also has `extracted_to: <path>` pointing at the extracted helper you created per Branch 1 — that's what the factory must import and call. A bare `needs_extraction: true` with no `extracted_to` means you skipped the extraction step; HALT and extract.
2. For each such model, open the handler file and verify BOTH:
   - an `import` line pulls in `creation_function` (or the class that owns it) from a path that resolves to `creation_file`
   - the `defineFactory({ create })` body invokes that symbol (e.g. `manager.getState(...)`, `createUser(...)`, `ProjectService.create(...)`)
3. Spot-check with grep — any inline ORM create inside a factory for a model marked `independently_created: true` is the anti-pattern:
   ```bash
   grep -nE '(prisma|db|tx)\.[a-zA-Z]+\.create\(' <handler-file>
   ```
   Cross-reference each match against the audit; replace inline calls with the real function before continuing.

If any factory fails this check, fix it before reporting success. The full lifecycle validation in Step 5 will otherwise find it the hard way.

---

## Phase 5: Report

Tell the user:

> "Done! I've set up the Autonoma SDK at `[endpoint path]`.
>
> **Packages installed**: [list]
> **Factories registered** (from entity-audit.md): [list each model + the `creation_file#creation_function` it calls (or the repository call for `independently_created: false`) + side effects observed]
> **Auth**: [how sessions/tokens are created]
>
> **Smoke test**: discover returns schema with [N] models; factory-integrity check passed for [N] factories.
>
> **Next steps**:
> 1. Set your secrets in `.env`:
>    ```
>    AUTONOMA_SHARED_SECRET=<your-value>
>    AUTONOMA_SIGNING_SECRET=<your-value>
>    ```
> 2. Proceed to Step 5 to validate the full up/down lifecycle against every scenario.
> 3. When ready, paste `AUTONOMA_SHARED_SECRET` into the Autonoma dashboard."

---

## Important reminders

- **Never create a standalone server or sidecar.** Always integrate into the backend you identified in Phase 1.1. If that's not possible, stop and ask the user — do not invent a workaround.
- **SDK language must match backend language.** Do not install `autonoma-ai` (Python) into a TypeScript/NestJS project, etc.
- **Do not scaffold at the repo root** when a backend directory exists, including non-standard names like `core-app-backend/`, `apps/api/`, `services/core/`.
- **Always read the live docs** at `https://docs.agent.autonoma.app/llms.txt` before implementing. The SDK may have been updated.
- **ALL database writes go through the SDK endpoint.** Never write directly via psql, raw SQL, or ORM methods.
- **Register a factory for every model in the entity audit** — there is no SQL fallback. For `independently_created: true` rows the factory must call the audit's identified function; for `independently_created: false` rows a thin repository call is fine. Never reimplement an identified creation function inline.
- **Validate is Step 5's job.** This step only runs `discover` plus the factory-integrity check. Do not try to run `up`/`down` here.
- **Match existing codebase patterns.** Don't introduce new conventions. Use the same import style, file organization, and error handling.
- **Use `testRunId`** in all unique fields (emails, slugs, org names) to prevent parallel test collisions.
- **If context compaction occurs**, re-read this prompt and use a TODO list to track progress.

</details>
