---
title: "Step 2: Entity Creation Audit"
description: "Describe every way each database model is created so the Environment Factory can plan factories, scenario trees, and teardown correctly."
---

The entity creation audit agent reads your codebase and, for every database model, answers **two orthogonal questions**:

1. **`independently_created`** — does the codebase have an exported function that creates this model on its own?
2. **`created_by`** — which other models' creation flows produce this model as a side effect?

Both facts can be true simultaneously. A model can have its own `<Child>Service.create()` **and** be minted inline inside a parent's `<Root>Service.createRoot()` transaction as a required child. The audit captures both; downstream steps pick the right path per use case.

This step runs **after** the knowledge base is generated (Step 1) and **before** scenario generation (Step 3). Its output feeds directly into Step 4 (Implement & Validate), so the generator knows which models need factories, which come along as byproducts, and how to tear them down.

## Why two fields instead of one

Earlier versions of this audit used a single `has_creation_code` boolean. That was too coarse. Some models are **dual**: they have a standalone creation path *and* are produced inline by a parent's transaction. A single flag forces the downstream pipeline to pretend one of those truths doesn't exist — either fabricating a factory for a dependent that was never meant to be created standalone, or ignoring the standalone path when it's the one a scenario actually wants to exercise.

Two orthogonal fields capture all four states cleanly:

| `independently_created` | `created_by` | Meaning |
|---|---|---|
| `true` | `[]` | Pure root — only standalone creation exists. |
| `true` | non-empty | Dual — has a standalone path AND is produced by at least one owner. |
| `false` | non-empty | Pure dependent — only reachable via an owner's creation flow. |
| `false` | `[]` | **Invalid** — unreachable model (either you missed the owner, or the model is never created). |

## What the agent records

### `independently_created: true`

These models get their own factory in the Environment Factory handler. The audit records:

- `creation_file` — path to the file with the creation logic
- `creation_function` — exported function name
- `side_effects` — observed side effects (password hashing, slug generation, sibling inserts, external calls)
- `needs_extraction` — optional flag set when the only creation path is inline in a route handler or framework-hook closure; the env-factory agent will lift it into a named export before wiring the factory

### `created_by: [{owner, via, why}]`

For every sibling row an owner mints inline, the dependent gets a `created_by` entry pointing back. The `why` field is prose — it flows verbatim into scenario guidance and env-factory teardown hints, so it needs to be specific:

- ✅ "Every new `<Root>` needs a default child created inline in the same transaction so the UI has something to read from the start."
- ❌ "Creates a child."

## Factory vs raw SQL

The SDK creates test data two ways per model:

- **Factory** — calls your application's creation code, preserving every side effect
- **Raw SQL INSERT** — fast, skips application logic

Rule: every `independently_created: true` model gets a factory. Every pure dependent falls back to raw SQL and is torn down via its owner's factory (see [Environment Factory guide](/guides/environment-factory/)).

## Prerequisites

- `autonoma/AUTONOMA.md` and `autonoma/skills/` must exist (output from [Step 1](/test-planner/step-1-knowledge-base/))
- Access to your backend codebase — the agent needs to read service files, repositories, and route handlers

## What this produces

`autonoma/entity-audit.md` — a structured audit of every database model with YAML frontmatter:

```yaml
---
model_count: 5
factory_count: 3
models:
  - name: <Root>
    independently_created: true
    creation_file: src/<domain>/<domain>.service.ts
    creation_function: <Root>Service.create
    side_effects:
      - mints a default <Child> in the same transaction
      - seeds an <OnboardingLike> row
    created_by: []

  - name: <User>
    independently_created: true
    creation_file: src/<auth-module>/<auth-module>.ts
    creation_function: <AuthProvider>.databaseHooks.user.create
    side_effects:
      - hashes password
      - creates default <Tenant> + <Member> rows
    created_by: []

  - name: <Child>
    independently_created: true
    creation_file: src/<child-domain>/<child-domain>.service.ts
    creation_function: <Child>Service.create
    side_effects: []
    created_by:
      - owner: <Root>
        via: <Root>Service.create
        why: "Every new <Root> needs a default <Child>, created inline in the same transaction."

  - name: <PureDependent>
    independently_created: false
    created_by:
      - owner: <Root>
        via: <Root>Service.create
        why: "Minted inside the <Root> transaction so downstream features have a row to read."

  - name: <OnboardingLike>
    independently_created: false
    created_by:
      - owner: <Root>
        via: <Root>Service.create
        why: "Seeded with the <Root> row so the onboarding UI has something to advance through."
---
```

The body contains:

- **Roots** — headings for every `independently_created: true` model with file/function and the siblings it mints.
- **Dependents** — a table of every `independently_created: false` model mapping to its owner(s) and the `why`.
- **Dual-creation models** — a call-out listing every model that is both root and dependent, with guidance on when to use each path.

## Review checkpoint

For each `independently_created: true` model:
- Is the identified file/function the one you'd actually call in production?
- Are important side effects missing from the list?
- If `needs_extraction: true`, is that really the only creation path (vs. the agent missing a named service)?

For each `independently_created: false` model:
- Do the `created_by` entries list every owner that mints it? (Multiple owners are fine.)
- Do the `why` entries actually explain the motivation, or are they restating the code?

For each dual model:
- When would a test want the standalone path vs. the via-owner path? That decision drives scenario shape.

If a dependent has no `created_by` entry, **the audit is broken** — either the agent missed a creation path or the model is orphaned in the schema. The audit validator refuses to ship in that state.

## What happens next

In Step 4 (Implement & Validate), the generator:

1. Reads `autonoma/entity-audit.md`
2. Registers one factory per `independently_created: true` model
3. Lets the SDK fall back to raw SQL for every pure dependent
4. Plans teardown per root using the `created_by` graph (see [Environment Factory guide](/guides/environment-factory/))

You don't manually split "factory" vs "raw SQL" — the audit + hybrid SDK handle it.

## The prompt

<details>
<summary>Expand full prompt</summary>

The live agent prompt lives in the plugin at `agents/entity-audit-generator.md`. It encodes:

- The two orthogonal questions and the four-state matrix above.
- Pass A (find standalone paths) and Pass B (find sibling inserts), both parallelizable.
- Schema rules for the output frontmatter.
- The invariant check: a dependent with empty `created_by` is a bug; fix the audit before writing.
- Instructions for using `curl` + `autonoma/.docs-url` to fetch this page at run time.

</details>
