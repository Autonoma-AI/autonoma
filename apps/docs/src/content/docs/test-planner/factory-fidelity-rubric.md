---
title: Factory fidelity rubric
description: Semantic rubric used by the plugin to verify that each factory faithfully reproduces the side effects the Step 2 audit recorded.
---

This page is fetched at runtime by the plugin's `.endpoint-implemented` hook. The hook spawns one `claude -p` subprocess per audited model, passing this rubric + the prompt template below. The model returns a JSON verdict. If any model fails, the sentinel is blocked and the compiled feedback is returned to the env-factory agent so it can fix itself.

Edit this page to tune the rubric — the plugin refetches it on every run, so changes take effect without cutting a new plugin version. **Keep every example in this page generic** (use placeholders like `<Model>`, `<ModelService>`, `src/<domain>/<domain>.service.ts`). The rubric is consumed by projects in many languages and ORMs; codebase-specific names would bias the validator toward projects that happen to share those names.

## Scope — which models this rubric judges

The entity audit classifies every model with two orthogonal fields:

- `independently_created: true` means the codebase has a standalone creation path (service, repository, framework hook) for this model. These get their own factory in the handler and are the only models this rubric judges.
- `created_by: [{owner, via, why}]` lists the other models whose creation flows produce this one as a side effect. Pure dependents (`independently_created: false`) never have factories of their own — they fall back to raw SQL or come along with their owner's factory — so the rubric skips them entirely.

A **dual** model (`independently_created: true` AND non-empty `created_by`) has both a standalone path and an owner that mints it inline. The rubric judges only the standalone path; the via-owner path is the scenario generator's concern. A dual model's factory is faithful iff the standalone path is faithful.

## Rubric

A factory for a model is **faithful** if and only if **every** one of the following criteria passes. Any single failure is a hard fail.

### Criterion 1 — Uses the codebase's creation path, not raw ORM access

The failure mode this catches: the factory body (or a helper it imports) contains a direct database write — `db.<model>.create(...)`, `prisma.<model>.create(...)`, `tx.insert(<table>)`, `<Model>.create(...)` on an ActiveRecord class, `session.add(...)` + `session.commit()`, a raw `INSERT INTO ... VALUES ...`, etc. — **while the application already has a named service / repository / controller / helper function that performs the creation with its full business logic.**

The factory's call chain, starting at the `create(data, ctx)` body in the handler and following every import one level deep, must reach the `creation_function` named in the **Step 2 audit snapshot** (not the current audit). The Step 2 snapshot is ground truth — it was captured before the factory was written and names the function in the application codebase that performs the real creation.

A factory "uses the codebase's creation path" if it calls the Step 2 `creation_function` directly, or calls a one-line wrapper that calls it. A factory "uses raw ORM access" if the only write observable in its call chain is a database operation with no business-logic wrapper.

**Framework-hook carve-out (`needs_extraction: true`).** When Step 2 recorded `needs_extraction: true` and `extracted_to: <path>`, the `creation_function` is a framework hook or route closure (Better-Auth `databaseHooks.*`, NextAuth callbacks, Devise callbacks, inline route handlers) that the factory **cannot** call directly — it only runs when the framework's own entry point is invoked. For these models, Criterion 1 passes iff **(a)** the factory calls the function at `extracted_to` (the lifted named export), AND **(b)** that function's body reproduces the hook's call chain (same sibling services / events / analytics). The factory MUST NOT call the hook name itself, and MUST NOT use raw `db.<model>.create(...)`. A raw write in this case fails both Criterion 1 and Criterion 4.

- **PASS** — Factory calls `<Model>Service.create(...)` (from `src/<domain>/<domain>.service.ts`) which is exactly the function Step 2 named and performs whatever hashing / derivation / sibling writes / external calls the service performs in production.
- **PASS (`needs_extraction: true`)** — Factory calls the `extracted_to` function and that function's body contains the same sibling writes / external calls as the original hook.
- **FAIL** — Factory (or its helper) contains `db.<model>.create({ data })` or equivalent raw write, and the Step 2 audit named a service / repository / controller method that is never invoked.
- **FAIL** — Factory imports a freshly-written helper whose body is just `return db.<model>.create({ data })`. The Step 2 function in the application codebase is bypassed.

### Criterion 2 — Preserves every side effect the audit recorded

The Step 2 audit entry for each model includes a `side_effects:` list. Every item on that list must be reproduced by the call chain, either directly (same function is called) or through an equivalent path (a helper that invokes the same downstream code).

Side effects commonly include:
- Writes to sibling tables (e.g. `Organization` / `Member` / `BillingCustomer` when creating a `User` — actual names vary per project)
- Hashing or cryptographic operations (password hashing, API key hashing, token signing)
- External service calls (analytics events, Slack / email / webhook / GitHub / Stripe)
- State-machine transitions (onboarding advancement, setup status, lifecycle flags)
- Derived field generation (slugs, tokens, refs, search vectors)

The factory MAY omit a side effect only if the audit's `side_effects` list explicitly marks it as skippable. The older "sibling factory escape hatch" is gone — if a side effect genuinely belongs to another model, the audit must record that via `created_by` on the sibling, not via a comment in this factory.

- **PASS** — Factory's call chain reaches the Step 2 `creation_function`, which invokes the sibling-write / hashing / external-call helpers named in `side_effects`.
- **FAIL** — Helper file contains a comment admitting missing side effects ("we replicate that logic here without the external side effects", "no business logic beyond the raw insert", "skipping the hooks for the test env") — this is explicit admission that side effects were dropped.
- **FAIL** — A side effect from the audit's list is missing from the call chain and no comment explains why it is safe to drop.

### Criterion 3 — `creation_file` in the current audit matches the Step 2 snapshot

For every model with `independently_created: true`, the current `creation_file` must equal the Step 2 snapshot's `creation_file`. The Step 2 audit is a statement about the **existing codebase** — it cannot be repointed at a file the agent wrote for the factory. If Branch 1 extraction is used, the agent should add an `extracted_to:` field; it MUST NOT overwrite `creation_file`.

- **PASS** — `creation_file` unchanged between snapshot and current.
- **FAIL** — `creation_file` changed from a path in the application codebase (e.g. `src/<domain>/<domain>.service.ts`) to a path inside the factory / handler directory (e.g. `src/<handler-dir>/<factories-file>.ts`).

### Criterion 4 — No raw-write helpers masquerading as extractions

If the factory imports a helper (Branch 1 extraction), the helper MUST either:
1. Call the Step 2 `creation_function` directly (thin wrapper), or
2. Be the Step 2 `creation_function` itself (the file was renamed/moved but the function is the original code).

A helper that contains only a raw database write (`db.<model>.<create|insert|upsert>(...)`, `tx.insert(<table>)`, `<Model>.create(...)` on an ORM class, raw `INSERT` SQL, etc.) with no other business logic is a **raw-write helper**, not an extraction, and fails this criterion.

Branch 1 extraction is a refactor of the application codebase — it lifts inline logic out of a closure/hook into a named export and wires the original HTTP caller to call it. The extracted function keeps every side effect. A helper created fresh inside the factory directory that only wraps the ORM has not extracted anything.

- **PASS** — Helper is a thin wrapper, e.g. a one-line `return <realService>.create(data)` that calls the Step 2 function.
- **PASS** — Helper IS the Step 2 function (the file was moved during Branch 1; the body is unchanged and still calls every sibling helper).
- **FAIL** — Helper body is `return db.<model>.create({ data: {...} })` with no call to any service / repository / controller named in the Step 2 audit.

## Reference examples — `defineFactory`

These examples are deliberately generic so they apply to any codebase. Read them as templates for the shape a faithful factory takes versus the shapes that fail each criterion.

### Good — calls the existing service (Branch 2, no extraction needed)

```ts
// handler file — imports the service that already exists in the codebase.
import { UserService } from "../../users/user.service";

export const factories = {
    User: defineFactory({
        async create(data, ctx) {
            // UserService.create is the Step 2 creation_function. It hashes
            // passwords, provisions Org + Member + Billing rows, fires
            // signup analytics, and returns the created user.
            return UserService.create(data, { executor: ctx.executor });
        },
    }),
};
```

### Good — thin wrapper after Branch 1 extraction

```ts
// src/auth/create-user.ts — lifted OUT of the Better-Auth hook closure so the
// factory can reuse the same code path. Original hook now calls this too.
// Extracted from the databaseHooks.user.create closure for Environment Factory
// reuse (preserves Org + Member + billing provisioning). See
// autonoma/entity-audit.md.
export async function createUser(input: CreateUserInput, deps: AuthDeps) {
    const user = await deps.db.user.create({ data: { ...input, password: hash(input.password) } });
    await ensureOrgMembership(user, deps);
    await ensureBillingProvisioning(user, deps);
    await analytics.capture("user_signed_up", { userId: user.id });
    return user;
}

// handler file
import { createUser } from "../../auth/create-user";

export const factories = {
    User: defineFactory({
        async create(data, ctx) {
            return createUser(data, { db: ctx.executor, analytics, billing });
        },
    }),
};
```

### Bad — raw ORM in the factory body (fails Criterion 1)

```ts
import { db } from "../../db";

export const factories = {
    User: defineFactory({
        async create(data, ctx) {
            // WRONG — bypasses UserService.create (Step 2 creation_function).
            // Password is not hashed. Org / Member / Billing rows are never
            // created. Every downstream test that reads them will break.
            return db.user.create({ data });
        },
    }),
};
```

### Bad — raw-write helper masquerading as an extraction (fails Criterion 4)

```ts
// src/<handler-dir>/factories-helpers.ts — created for the factory only.
// The comment is the tell: it documents dropping side effects instead of
// preserving them.
export async function createUser(db, data) {
    // better-auth's internal adapter does the same thing — no business logic
    // beyond the raw insert.
    return db.user.create({ data, select: { id: true } });
}

// handler file
import { createUser } from "./factories-helpers";

export const factories = {
    User: defineFactory({
        async create(data, ctx) {
            return createUser(ctx.executor, data); // fails Criterion 4
        },
    }),
};
```

### Bad — audit rewrite (fails Criterion 3)

The Step 2 snapshot recorded `creation_file: src/auth/auth.ts`. The agent wrote a raw-write helper at `src/<handler-dir>/factories-helpers.ts` and rewrote the current audit's `creation_file` to point there. Even if every other criterion passed, Criterion 3 fails because the immutable ground-truth column was overwritten.

## Prompt template

The plugin hook substitutes `{{placeholders}}` below before invoking `claude -p`. The hook reads everything between `<!-- prompt:begin -->` and `<!-- prompt:end -->` (exclusive) as the raw template.

<!-- prompt:begin -->
You are a semantic validator for an Autonoma Environment Factory handler.
Your job is to answer: does the factory for ONE model faithfully reproduce the
creation behaviour that the Step 2 audit recorded? Apply the rubric EXACTLY.

The rubric's examples use generic placeholders (`<Model>`, `<ModelService>`,
`src/<domain>/<domain>.service.ts`). Map them to whatever names the target
codebase actually uses — service, repository, controller, helper function,
module, etc. The rule is about the SHAPE of the call chain, not specific
file paths or class names.

## Rubric (from the Autonoma docs)

{{RUBRIC}}

## Inputs for model: {{MODEL}}

### Step 2 audit entry (ground truth — immutable)

```yaml
{{STEP2_AUDIT_ENTRY}}
```

### Current audit entry (may have drifted)

```yaml
{{CURRENT_AUDIT_ENTRY}}
```

### Factory registration in the handler

File: {{HANDLER_PATH}}

```
{{FACTORY_BLOCK}}
```

### Extraction status (from Step 2 snapshot)

- `needs_extraction`: {{NEEDS_EXTRACTION}}
- `extracted_to`: {{EXTRACTED_TO}}

When `needs_extraction` is `true`, the Step 2 `creation_function` is a
framework hook or inline route closure that cannot be called directly. The
factory is expected to call the function at `extracted_to`. Apply the
"Framework-hook carve-out" in Criterion 1.

### Helper(s) the factory calls

{{HELPER_SECTION}}

If the section above says the factory helper was "not resolvable", treat
this as missing-context, NOT as evidence of a raw-write factory. In that
case return `error` (see Task) instead of `fail` for criteria that depend
on inspecting the helper body.

### Original creation_function from Step 2 snapshot

File: {{ORIGINAL_CREATION_FILE}}

```
{{ORIGINAL_CREATION_SNIPPET}}
```

## Task

Apply Criteria 1–4 above. For each criterion: PASS, FAIL, or ERROR with a
one-sentence reason. Use ERROR only when the information needed to judge
the criterion is genuinely absent from the inputs (e.g. helper code was not
provided and the helper is the only path through which the criterion could
be satisfied). Do NOT use ERROR as a substitute for FAIL when the inputs
clearly show a violation.

Overall verdict:
- `pass` — every criterion is PASS.
- `fail` — at least one criterion is FAIL.
- `error` — no criterion is FAIL and at least one is ERROR.

Respond with ONLY a JSON object on a single line, no prose, no code fences:

{"model": "{{MODEL}}", "verdict": "pass" | "fail" | "error", "criteria": [{"id": 1, "status": "pass|fail|error", "reason": "..."}, {"id": 2, ...}, {"id": 3, ...}, {"id": 4, ...}], "fix_hint": "one actionable sentence or empty string"}
<!-- prompt:end -->

## How the hook uses this

1. On write of `autonoma/.endpoint-implemented`, the plugin fetches this page.
2. It splits the content at `## Prompt template` — the section above is `{{RUBRIC}}`, the block between `<!-- prompt:begin -->` / `<!-- prompt:end -->` is the prompt template.
3. For every model with `independently_created: true` in the Step 2 snapshot, it fills the placeholders and runs `claude -p --output-format json` in parallel (bounded concurrency).
4. It parses the JSON result from the `result` field of the outer envelope and collects `fail` verdicts. If any exist, it blocks the sentinel with the compiled feedback.

The env-factory agent receives the feedback as stderr from the blocked write and can self-correct. The feedback includes the per-criterion reasons and a `fix_hint` for each failing model.

### On "can claude answer?"

Yes — `claude -p --output-format json` returns the assistant's response in the `result` field of a JSON envelope on stdout. The plugin parses that envelope, then parses the inner JSON the prompt asked for. No intermediate file is needed, which keeps the subprocess stateless and the fan-out cheap. If a future rubric change needs structured artifacts bigger than a single JSON object, the template can be updated to ask the model to write a file at a caller-supplied path — but for the current pass/fail + per-criterion reasoning shape, the return envelope is the right channel.
