---
title: "Step 3: Generate Scenarios"
description: "Design the standard, empty, and large test data environments from the knowledge base and the entity audit."
---

The scenario generator takes your knowledge base and entity audit and produces `scenarios.md` — a description of the test data environments the rest of the pipeline will depend on.

Each scenario is a nested tree of records rooted at your **scope entity** (e.g., `Organization`, `Tenant`, `Workspace`). The tree mirrors the foreign-key structure of your schema and becomes the `create` payload the SDK sends to your Environment Factory in Step 5.

> The JSON file this eventually produces is uploaded to Autonoma's `/v1/setup/setups/:id/scenario-recipe-versions` endpoint. The exact upload contract - `version`, `source.discoverPath`, `validationMode`, `recipes[]`, and the `variables` tagged union - is documented in the [Scenario Recipe Schema reference](/reference/scenario-recipe-schema/). Read that before writing a recipe generator or debugging an upload rejection.

## Prerequisites

- `autonoma/AUTONOMA.md` and `autonoma/skills/` must exist (output from [Step 1](/test-planner/step-1-knowledge-base/))
- `autonoma/entity-audit.md` must exist (output from [Step 2](/test-planner/step-2-entity-audit/))
- Access to your backend codebase — the agent reads the ORM schema directly (Prisma schema, Drizzle tables, Ecto schemas, ActiveRecord models, etc.) to understand relationships

## What this produces

`autonoma/scenarios.md` — a markdown file with YAML frontmatter describing:

- `scenario_count` and the list of `scenarios` (at minimum `standard`, `empty`, `large`)
- `entity_types` — every model the scenarios reference
- `variable_fields` — values that must vary across runs, with `{{token}}` placeholders
- `planning_sections` — the agent's schema summary, relationship map, and variable-data strategy

Each scenario is a fully specified nested tree:

- **`standard`** — realistic day-to-day coverage; the workhorse scenario
- **`empty`** — zero-state and onboarding flows
- **`large`** — pagination, filtering, and high-volume behavior

## Variable fields

Most values in a scenario should be **fixed** — the test can assert against them directly (e.g., "click the project titled 'Launch Campaign'"). A value should only be marked as a variable `{{token}}` when it genuinely must vary across runs:

- globally unique fields (emails, slugs, usernames)
- time-sensitive fields (timestamps, tokens with TTL)
- backend-generated fields the frontend cannot predict

Tests reference variable fields symbolically: `click the project titled ({{project_title}} variable)`. Marking too many fields as variable makes tests brittle; marking too few causes collisions across parallel runs.

## What to review

- **Root scope entity** — every scenario tree roots at the same scope model. If your app is multi-tenant on `Organization`, the tree should start at `Organization` and every descendant must be reachable via FK nesting.
- **Entity coverage** — the important entities from the knowledge base are represented. Missing entities mean core flows won't have data to run against.
- **Fixed vs variable** — fixed values are realistic (no "asdf" test data). Variable fields are limited to values that genuinely must vary.
- **Scenario differentiation** — `empty` and `large` are meaningfully different from `standard`. Don't let `large` just be "standard with more rows" — it should exercise pagination, filtering, and overflow.
- **Feasibility** — the tree you see here will be passed to the SDK verbatim in Step 5. If a required FK or unique constraint is missing, Step 5 will fail. Catching it here is cheaper.

Step 4 installs the SDK and Step 5 validates the scenarios against the real database. If scenarios are wrong, Step 5 will either fail or edit this file to match reality — review those edits carefully.

## The prompt

<details>
<summary>Expand full prompt</summary>

# Scenario Generator

You generate test data scenarios from a knowledge base. Your input is `autonoma/AUTONOMA.md`, `autonoma/skills/`, and `autonoma/entity-audit.md`. Your output MUST be written to `autonoma/scenarios.md` with YAML frontmatter.

## Instructions

1. Fetch Autonoma documentation via `curl` only (not WebFetch). The docs base URL lives in `autonoma/.docs-url`.

   ```bash
   curl -sSfL "$(cat autonoma/.docs-url)/llms/test-planner/step-3-scenarios.txt"
   ```

2. Read `autonoma/AUTONOMA.md` fully — understand the application, core flows, and entity types.

3. Read `autonoma/entity-audit.md` — the authoritative schema map from Step 2. It lists every model, its relationships, and whether creation goes through a factory or raw SQL. Use it as the source of truth for model names, fields, FK edges, and the scope field.

4. Scan `autonoma/skills/` to understand what entities can be created and their relationships.

5. Explore the backend codebase only to fill gaps the audit does not cover (enum values, string length limits, constraint details).

6. **Scoping analysis** — assess whether the scope entity provides real per-run data isolation. Does the scope entity parent most other models via required FKs? Can a new scope entity be created per test run? Do most models eventually chain back to the scope entity?

   If yes to all: the app has natural multi-tenant isolation — each test run creates its own scope entity.

   If the scope entity is a singleton, shared across users, or does not meaningfully partition data: the app **lacks natural per-run isolation**. In this case you MUST slug all identifying fields with `{{testRunId}}` so parallel or sequential runs never collide.

7. Design three scenarios: `standard`, `empty`, `large`.

8. **Variable fields.** Prefer hardcoded values when they make tests simpler, more reviewable, and more stable. If a field needs run-level uniqueness but can still be expressed as a concrete literal, prefer a planner-chosen hardcoded value with a discriminator suffix over introducing a variable placeholder (e.g. `Acme Project qa-17` over `{{project_name}}`).

   **Exception — apps without natural per-run isolation:** if your scoping analysis determined the app lacks natural isolation, **reverse the default**. Slug ALL identifying fields — names, titles, descriptions, labels, slugs, emails, usernames — with inline `{{testRunId}}`.

   Only mark a value as variable when at least one of these is true:
   - the field must be globally unique or is highly collision-prone across runs
   - the backend or SDK generates the value at runtime
   - the value is inherently time-based, unstable, or nondeterministic
   - hardcoding it would make later tests misleading or brittle
   - the app lacks natural per-run isolation and the field is used in lookups, searches, or assertions

   Every variable field must have:
   - a double-curly token such as `{{project_title}}`
   - the entity field it belongs to, such as `Project.title`
   - the scenario names that use it
   - a reason explaining why it truly must vary
   - a plain-language test reference such as `({{project_title}} variable)`

9. **Nested tree constraint.** Design scenario entity tables so they can be expressed as a nested tree rooted at the scope entity. Step 4 and Step 5 convert scenarios into nested `create` payloads — flat cross-model structures connected only by `_ref` break when JSON key order is not preserved. Children must nest under their parent using the relation field names from the audit. Use `_ref` only for cross-branch references.

10. **Standalone vs via-owner.** For every model, consult the Step 2 audit:

    - Models with `independently_created: true` may appear as top-level tree nodes when the scenario wants them in isolation.
    - Models whose `created_by` list contains an owner already in the tree must NOT appear as separate nodes — they're minted inline by the owner's factory. Quote the `why` from the audit in the scenario prose so the reader knows where they came from.
    - **Dual models** (both `independently_created: true` AND in some owner's `created_by`) pick per scenario: narratives that create a standalone child use the standalone factory; narratives that spin up a fresh root let the child come in via the owner.

    Never double-create a dependent. If an owner mints a dependent row inline and your scenario already includes that owner, don't also add the dependent as a sibling node — the factory already creates it, and duplicating it either fails uniqueness checks or produces confusing state.

10. Write `autonoma/scenarios.md`.

## Output format

```yaml
---
scenario_count: 3
scenarios:
  - name: standard
    description: "Full dataset with realistic variety for core workflow testing"
    entity_types: 8
    total_entities: 45
  - name: empty
    description: "Zero data for empty state and onboarding testing"
    entity_types: 0
    total_entities: 0
  - name: large
    description: "High-volume data exceeding pagination thresholds"
    entity_types: 8
    total_entities: 500
entity_types:
  - name: "User"
  - name: "Project"
variable_fields:
  - token: "{{project_title}}"
    entity: "Project.title"
    scenarios: [standard, large]
    generator: "planner literal plus discriminator"
    reason: "title must be unique per test run"
    test_reference: "({{project_title}} variable)"
planning_sections:
  - schema_summary
  - relationship_map
  - variable_data_strategy
---
```

The body of the file must include:
- `## Schema Summary` — key models and required fields driving the scenarios
- `## Relationship Map` — parent/child and FK relationships
- `## Variable Data Strategy` — which values are generated and how tests reference them
- (Optional) `## Scoping Analysis` — if the app lacks natural per-run isolation
- Scenario sections for `standard`, `empty`, `large` with credentials and entity tables

## Important

- **The scenario data is a contract.** Fixed values are hard assertions; variable fields are explicit placeholders.
- Prefer concrete literals unless the field truly must vary across runs.
- Do not default to `faker`. Prefer deterministic strategies.
- Every value must be concrete — not "some applications" but "3 applications: Marketing Website, Android App, iOS App."
- Every enum value must be covered in `standard`.
- Only use `{{testRunId}}` as a template token in scenario bodies. Custom tokens like `{{user_email_alice}}` are only valid in `variable_fields` declarations.
- Design scenarios so each entity table can be serialised as a nested tree rooted at the scope entity.

</details>
