---
title: "Step 2: Generate Scenarios"
description: "Design three named test data environments that the E2E test suite will assert against, now using SDK discover as schema input."
---

:::note[We're simplifying this]
We know the current scenario setup is more complex than it needs to be. We're actively working on a much simpler version that should be ready in the next couple of weeks. In the meantime, the process below still works - but expect it to get significantly easier soon.
:::

The scenario generator still designs three named test data environments: `standard` (realistic variety for most tests), `empty` (for empty state testing), and `large` (for pagination and performance). Every scenario still needs concrete names, counts, and explicit relationships.

What's changed is **how the planner gets its data model**. Instead of trying to reconstruct the schema from scattered backend files, Step 2 now consumes the SDK `discover` artifact first, then combines that schema snapshot with the AUTONOMA knowledge base to design the scenarios. The output is still `scenarios.md`, but it now also captures:

- the discovered schema summary
- foreign key and relation information
- which values are safe to hardcode
- which values must stay generated at runtime

## Prerequisites

- `autonoma/AUTONOMA.md` and `autonoma/skills/` must exist (output from [Step 1](/test-planner/step-1-knowledge-base/)).
- A working Environment Factory endpoint must already exist and respond to `discover`.
- The Step 2 runtime must have:
  - `AUTONOMA_ENV_FACTORY_URL`
  - `AUTONOMA_SHARED_SECRET`
- Access to your **backend codebase** is still useful for business context and naming, but the `discover` artifact is now the schema source of truth.

If the Environment Factory endpoint is not available, Step 2 must stop. It should not skip to Step 4, reorder the pipeline, or fall back to guessing the schema from random code search.

## What this produces

- `autonoma/discover.json` - the raw SDK `discover` response captured before planning starts
- `autonoma/scenarios.md` - three named scenarios (`standard`, `empty`, `large`) with credentials, entity inventories, relationship maps, discover metadata, and variable-field planning

## Review checkpoint

After the agent finishes, it will summarize the scenario data and ask for your feedback. This checkpoint still matters because scenarios are a **contract** - but there are now two kinds of contract data:

- **Fixed values** become hard assertions in the test suite.
- **Generated values** become named placeholders that the tests reference symbolically instead of as hardcoded literals.

Here's what scenarios are and why they matter:

**What scenarios are.** Each scenario is a named test data environment - an isolated database state with a specific inventory of entities. Before each test run, Autonoma calls your Environment Factory endpoint to create this data fresh. After the run, it tears it all down. Every run starts clean.

**Why tests still reference exact values.** The test generation agent in Step 3 still writes tests that assert against specific names, counts, and relationships from your scenarios. If the `standard` scenario says there are 15 failed runs, a test may literally assert "the runs page shows 15 failed runs."

**Why some values must stay variable.** Some fields cannot safely be hardcoded across runs - unique titles, emails, slugs, or anything derived from `testRunId`. Those values must be recorded as placeholders like `<project_title>` so later tests say `(<project_title> variable)` instead of pretending the data is a stable literal.

**What to review:**

- **Schema coverage** - Does the discover summary include the important entities, required fields, and relationships your product actually uses?
- **Entity names** - Are fixed values realistic and unambiguous? Can you tell "Marketing Website" from "Analytics Dashboard" without confusion? Vague names like "App 1" make tests harder to read and debug.
- **Counts** - Does the `standard` scenario have enough variety to test all filter and category options? If your app has 5 status types, there should be at least one entity in each status.
- **Relationships** - Is it explicit which entities belong to which? "Login Flow is in the Smoke Tests folder" is good. "There are 10 tests and 5 folders" with no mapping is useless.
- **Variable fields** - Are the generated fields correctly marked instead of being accidentally presented as stable literals?

:::caution[This is still a contract]
If you approve a fixed scenario value such as "58 runs - 30 Passed, 15 Failed," both the test suite (Step 3) and the scenario validation step (Step 4) will use those numbers. If you approve a generated value token such as `<project_title>`, later tests must reference that token instead of inventing a literal.
:::

## The prompt

<details>
<summary>Expand full prompt</summary>

# Test Data Scenario Generator

You are a QA data architect. Your job is to analyze this codebase and produce a `scenarios.md` file that describes pre-configured test data environments for E2E tests. Each scenario is a named environment with credentials, a known inventory of entities, and their relationships.

These scenarios will be consumed by an automated testing agent. Tests reference scenarios by name in their Setup section (e.g., `Using scenario: standard`) and assert against the known data described here. **Most data should still be concrete and deterministic** - every stable entity should have a name, every list should have a count, every relationship should be explicit. Values that must stay generated should be recorded as named placeholders, not hardcoded literals.

---

## Phase 0: Locate and read the knowledge base

Before starting, locate the AUTONOMA knowledge base in the workspace:

1. Check for an `autonoma/` directory at the workspace root containing `AUTONOMA.md`, a `skills/` folder, and `discover.json`.
2. If not found, search more broadly: use grep/glob to search for `AUTONOMA.md` and `discover.json` anywhere in the workspace, or look for any directory named `autonoma` (case-insensitive) in subdirectories.

If none of these searches find the knowledge base, tell the user:

> "I need the AUTONOMA knowledge base to generate scenarios. Please run the AUTONOMA Knowledge Base Generator first, then come back and run this prompt."

Do not proceed without it.

If `discover.json` is missing or malformed, tell the user:

> "Step 2 requires a working Environment Factory endpoint. I need a valid SDK discover artifact before I can plan scenarios."

Do not proceed without it.

Once located, read the knowledge base:

- Read `AUTONOMA.md` fully. Understand:
  - What the application is and does
  - The user roles and permission levels
  - The **Core flows** section - these tell you which entities are central to the product
  - The **Core flows** table - this is the flat inventory of features/areas and whether each one is core
  - The **Preferences** section - respect skip/ignore directives
- Scan the `skills/` directory to understand what entities can be created and what relationships exist between them.

---

## Phase 1: Discovery

### 1.1 - Map the data model from SDK discover

Read `autonoma/discover.json` first and treat it as authoritative for:

- entity/model names
- fields and requiredness
- foreign keys
- relations
- scope field

Use it to identify **every entity type** that a user can create, view, edit, or delete through the UI. For each entity, determine:

- **Name**: What is this entity called? (e.g., "Project", "Test", "Run", "Folder", "Tag")
- **Fields**: What attributes does it have? (name, status, type, created date, etc.)
- **Relationships**: What other entities does it relate to? (belongs to, contains, tagged with, etc.)
- **Statuses/States**: What lifecycle states can it be in? (draft, published, active, archived, etc.)
- **Variants**: Are there sub-types or categories? (e.g., web/mobile/iOS, pre-run/post-run, admin/member)

**Where to look for business context:**

- **The SDK discover artifact** - this is the primary schema source of truth for entity types, fields, and relationships.
- **Backend code** - useful for naming, enums, and business rules, but do not replace `discover.json` with guessed schema discovery.
- **Frontend pages/components** - list pages, detail pages, forms, and tables reveal what entities the user interacts with and what fields are displayed.
- **Type definitions** - TypeScript interfaces, Zod schemas, or equivalent type files that describe UI-facing shapes.
- **The AUTONOMA knowledge base** - the "Core flows" table and detailed core flow sections list entities from a user perspective.

Do not proceed with scenario generation by reconstructing the schema manually if `discover.json` is missing. The data model will be incomplete and the scenarios will be inaccurate.

**Use subagents to parallelize discovery.** Launch multiple agents - one for the discover artifact, one for backend business rules, one for the frontend, and one for the knowledge base. Cross-reference their findings to build a complete picture.

### 1.2 - Identify entity hierarchies and dependencies

Map which entities depend on others:

- What must exist before other things can be created? (e.g., an "Organization" before a "Project", a "Project" before a "Test")
- What contains what? (folders contain items, organizations contain users)
- What references what? (tests reference applications, runs reference tests)

Use the FK edges and relations from `discover.json` as the baseline for this mapping.

### 1.3 - Identify enumerations and categorizations

Find every enum, status type, source type, or categorization in the data model:

- Entity statuses (draft, published, active, archived, etc.)
- Entity types/categories (web, mobile, iOS, etc.)
- Action sources (manual, scheduled, API, CI/CD, etc.)
- User roles (admin, member, viewer, etc.)
- Any other classification that affects how entities appear or behave in the UI

These must be represented in the scenario data so tests can filter, sort, and assert against specific categories.

### 1.4 - Identify lists, tables, and pagination

Find every page in the application that displays a list or table of entities. For each one, determine:

- What entity type it displays
- How many items per page (pagination size)
- What filters are available
- What sort options exist
- Whether there's search functionality

This information determines how much data each scenario needs. If a list paginates at 25 items, the `large` scenario needs 26+ items of that type to test pagination. If a list has filters by status, the scenario needs items in multiple statuses.

---

## Phase 2: Design the scenarios

Create exactly three scenarios: `standard`, `empty`, and `large`. Each serves a distinct testing purpose.

### 2.1 - Scenario: `standard`

The default scenario for most tests. It should contain:

**Credentials:**
- An organization name, user email, password, and role
- The user should have full access (admin or equivalent) unless the app has no roles

**Data principles:**
- **Enough variety to test every filter and category.** If entities have types (web/mobile/iOS), include at least one of each. If entities have statuses (draft/published/active), include items in each status. If entities have sources (manual/scheduled/API), include items from each source.
- **Enough volume to be realistic but not overwhelming.** Typically 8-15 items for primary entities, 3-5 for secondary entities. The goal is enough data to test filters, sorting, and basic list behavior without hitting pagination.
- **Explicit relationships.** If entity A references entity B, the scenario must show which specific A connects to which specific B.
- **Named with realistic, distinguishable values.** Use descriptive names that a test can reference unambiguously: "Marketing Website", "Android Shopping App", "iOS Banking App" - not "Test 1", "Test 2", "Test 3".
- **Cover the core flows deeply.** Entities involved in core flows (from AUTONOMA.md) should have the most variety and detail. Supporting entities can be sparser.
- **Include enough runs/history/activity** (if the app has a history/activity/log concept) to ensure:
  - At least one item of each status type
  - Items spanning a reasonable date range (e.g., last 30-60 days)
  - Enough items to test date-based filtering
  - At least one notable/interesting item per status (e.g., a failed run with a specific error, a cancelled run, a run with warnings)
- **Prefer fixed values when safe.** If a value does not need per-run uniqueness and makes tests easier to read, keep it concrete.
- **Mark generated values explicitly.** If a field needs uniqueness, uses `testRunId`, or should never become a hardcoded test assertion, record it as a variable token instead of a literal.

**What to document for each entity type:**

Use a table format. Include every field that a test might need to reference or assert against. At minimum:
- Name/identifier
- Type/category (if applicable)
- Status (if applicable)
- Key relationships (parent, container, tags, etc.)
- Any counts that a test might verify (e.g., "4 steps", "3 versions")

After the entity tables, include a summary of aggregate counts and distributions that tests can assert against (e.g., "Total: 58 runs - 30 Passed, 15 Failed, 5 Running, 5 Pending, 3 Cancelled").

### 2.2 - Scenario: `empty`

An organization with zero data. Used for testing empty states, first-time user experience, and onboarding flows.

**Credentials:**
- A separate organization, user email, password, and role

**Data:**
- Explicitly list every entity type with "None" to confirm the scenario is intentionally empty.

**Include a "What to test with this scenario" section** listing:
- Empty state messages on every list page
- "Create your first X" CTAs
- Onboarding/welcome flow behavior
- Pages that should gracefully handle zero data

### 2.3 - Scenario: `large`

A high-volume organization for testing pagination, performance, and scale-related UI behavior.

**Credentials:**
- A separate organization, user email, password, and role

**Data principles:**
- **Exceed pagination thresholds.** If a list shows 25 items per page, this scenario should have 50+ items of that type to guarantee multi-page pagination. Calculate this from the pagination sizes discovered in Phase 1.4.
- **High counts but described in aggregate.** Don't list 120 items individually. Describe the count, distribution across types/statuses, and any notable items.
- **Enough to stress filters and search.** Multiple entities sharing the same tags/categories, deep folder hierarchies, long lists.
- **Reuse the same variable strategy as `standard`.** Large scenarios can still have generated values; just make sure the placeholders are documented clearly.

**Include a "What to test with this scenario" section** listing:
- Pagination behavior
- Filter performance with large result sets
- Sort stability across pages
- Search across many entities
- Bulk operations on large selections
- UI responsiveness with long lists

---

## Phase 3: Write the scenarios file

### 3.1 - Structure

Write the file with this exact structure:

```markdown
---
scenario_count: 3
scenarios:
  - name: standard
    description: [Description]
    entity_types: [count]
    total_entities: [count]
  - name: empty
    description: [Description]
    entity_types: [count]
    total_entities: [count]
  - name: large
    description: [Description]
    entity_types: [count]
    total_entities: [count]
entity_types:
  - name: [Entity Type 1]
  - name: [Entity Type 2]
discover:
  source: sdk
  model_count: [count]
  edge_count: [count]
  relation_count: [count]
  scope_field: [field name]
variable_fields:
  - token: <project_title>
    entity: Project.title
    scenarios: [standard, large]
    generator: faker.company.name
    reason: title must be unique per test run
    test_reference: "(<project_title> variable)"
---

# Test Data Scenarios

This file describes the pre-configured test data environments available for E2E tests. Each scenario has its own organization, user credentials, and a known set of data. Tests reference scenarios by name in their Setup section.

## SDK Discover

[Short summary of model count, edge count, relation count, and scope field]

## Schema Summary

[High-level summary of the important models and required fields from discover]

## Relationship Map

[Important FK paths and parent/child relations]

## Variable Data Strategy

[List every generated field token, what it stands for, and how tests should reference it]

---

## Scenario: `standard`

[Description - one sentence about what this scenario is for]

### Credentials

- **Organization**: [Name]
- **User**: `[email]` / `[password]`
- **Role**: [Role name] ([brief description of access level])

### [Entity Type 1 - plural, e.g., "Applications"]

| [Column headers matching the entity's key fields] |
|---|
| [Row per entity] |

### [Entity Type 2]

[Same pattern - table with all instances]

### [Entity Type N]

[Continue for every entity type in the data model]

### [History/Activity entity - e.g., "Runs"]

- **Total**: [count]
- **Status distribution**: [breakdown]
- **Source distribution**: [breakdown] (if applicable)
- **Date range**: [range], with [constraints for testing]
- **Notable items**:
  - [Description of specific items tests might reference]

---

## Scenario: `empty`

[Description]

### Credentials

- **Organization**: [Name]
- **User**: `[email]` / `[password]`
- **Role**: [Role]

### Data

- **[Entity Type 1]**: None
- **[Entity Type 2]**: None
- ...
- **[Entity Type N]**: None

### What to test with this scenario

- [Bullet list of what this scenario is for]

---

## Scenario: `large`

[Description]

### Credentials

- **Organization**: [Name]
- **User**: `[email]` / `[password]`
- **Role**: [Role]

### Data

- **[Entity Type 1]**: [count] [entities] ([distribution description])
- **[Entity Type 2]**: [count] [entities] ([distribution description])
- ...
- **[Entity Type N]**: [count] [entities]

### What to test with this scenario

- [Bullet list of what this scenario is for]
```

### 3.2 - Rules for writing scenario data

- **Every stable value must be concrete.** Not "some applications" but "3 applications: Marketing Website (Web), Android Shopping (Android), iOS Banking (iOS)." Tests will assert against these exact names.
- **Every relationship must be explicit.** If a test belongs to a folder, say which folder. If a run is for a specific test, say which test. Don't leave relationships ambiguous.
- **Every count must be exact** (for `standard`) **or described as a range/minimum** (for `large`). Tests need deterministic data in `standard` and guaranteed minimums in `large`.
- **Cover every enum value.** If entities have a status enum with 5 values, the `standard` scenario must include at least one entity in each status. If there's a type enum with 3 values, include at least one of each.
- **Use realistic, professional names.** "Marketing Website", "CI Pipeline Key", "Nightly Smoke" - not "Test App 1", "Key 1", "Schedule 1". Names should be distinguishable and memorable so test authors can reference them easily.
- **Include "notable" items for history/activity entities.** Tests often need to find a specific item - the most recent failed one, the one with warnings, the one from a specific source. Call these out explicitly.
- **Respect the knowledge base preferences.** If AUTONOMA.md says to skip an area, don't include data for entities in that area.
- **The `standard` scenario data should be sufficient for 80%+ of tests.** Only the most specialized tests (empty states, pagination, performance) should need the other scenarios.
- **Generated values must be declared, not hidden.** If a field needs uniqueness or is derived per run, add it to `variable_fields` and reference it by token instead of pretending it is a stable literal.
- **The discover summary is mandatory.** The file must show that the planner understood the SDK schema - model counts, relation counts, scope field, and the key relationships.

---

## Phase 3.5: Validation checklist

**Before producing any output, run through this checklist. Do not skip it. Do not proceed to Phase 4 until every item passes.**

Maintain a TODO list throughout this step. Before compaction, write your TODO list to a scratchpad so you can pick up where you left off. After compaction, re-read this prompt, re-read AUTONOMA.md and scenarios.md, and resume from your TODO list.

### Check 1: Scenario count is exactly 3

Count the number of scenarios in your output. There should be **exactly 3**: `standard`, `empty`, and `large`.

In extremely rare cases (e.g., multi-tenant apps where different tenants have fundamentally different data models, or apps with distinct user roles that need completely separate data sets), a 4th scenario may be justified. But this is the exception, not the rule.

**Hard limits:**
- 3 scenarios: correct for 99% of projects
- 4 scenarios: acceptable only with explicit justification written in the output
- 5-6 scenarios: almost certainly wrong - go back and merge scenarios
- 7+ scenarios: **absolutely not.** You have over-segmented. Each scenario is a separate database state that must be created, maintained, and torn down. Every extra scenario multiplies implementation cost in Step 4. Merge aggressively.

If you have more than 3 scenarios, ask yourself for each extra one: "Can I fold this into `standard` by adding a few more entities?" The answer is almost always yes.

### Check 2: Entity data is concrete and deterministic

Spot-check 5 entity tables in the `standard` scenario:
- Does every stable entity have a specific name (not "App 1" or "Test Entity")?
- Are relationships explicit (not "some tests are in folders" but "Login Flow is in the Smoke Tests folder")?
- Are counts exact numbers, not ranges?

If any are vague, fix them before proceeding.

### Check 3: Variable data is explicit

- Are all generated fields listed in `variable_fields`?
- Does every token use a placeholder format such as `<project_title>`?
- Does each generated field have a `test_reference` such as `(<project_title> variable)`?

If generated data is implied but not documented, fix it before proceeding.

### Check 4: Discover summary is present

- Does the frontmatter include `discover` metadata?
- Does the body include `## SDK Discover`, `## Schema Summary`, and `## Relationship Map`?
- Do the model, edge, and relation counts match the discover artifact?

If not, fix it before proceeding.

### What to do if checks fail

Fix the issue in place - do not start over. Then re-run the checklist. Only proceed to Phase 4 when all checks pass.

---

## Phase 4: Output

### 4.1 - Place the files

Write the discover artifact as `discover.json` and the scenarios file as `scenarios.md` in the same directory as the AUTONOMA knowledge base (inside `autonoma/` if it exists, or alongside `AUTONOMA.md`).

### 4.2 - Report to the user

Tell the user:

> "Done! I've generated Step 2 planning artifacts:
>
> - `discover.json` with the SDK schema snapshot
> - `scenarios.md` with 3 test data scenarios:
>
> **`standard`**: [brief summary - N entity types, key counts]
> **`empty`**: Zero data across all entity types, for empty state testing
> **`large`**: High-volume data [brief summary - key counts and pagination coverage]
>
> **Entity types covered**: [list all entity types]
> **Schema summary**: [model count], [edge count], [relation count], scope field `[scopeField]`
> **Generated values**: [count] variable fields documented for runtime generation
>
> **Next step**: Review the `standard` scenario carefully - it's the foundation for most tests. Make sure the entity names, counts, relationships, and variable-field markings match what you want in your test environment. After that, run the E2E test generation prompt to create test cases that reference these scenarios."

---

## Important reminders

- **Use the discover artifact as the schema source of truth.** Do not invent schema details if `discover.json` already tells you the real model.
- **The `standard` scenario is the most important.** It's what 80%+ of tests will use. Invest the most effort in making it complete, accurate, and realistic.
- **Be exhaustive with enum coverage in `standard`.** Every status, every type, every category, every source - at least one entity in each. This is what enables filter and category tests to assert against known data.
- **Relationships are as important as entities.** A scenario that lists 10 tests and 5 folders but doesn't say which tests are in which folders is useless. The test agent needs to know "Login Flow is in the Smoke Tests folder" to write `assert that "Login Flow" appears in the Smoke Tests folder`.
- **Don't invent features.** Only include entity types and fields that actually exist in the codebase and discover output. If the app doesn't have tags, don't add a tags section. If entities don't have a status field, don't fabricate statuses.
- **Match the UI vocabulary.** Use the same names the UI uses. If the app calls them "Projects" not "Workspaces", use "Projects". If statuses are "Active" and "Archived" not "Enabled" and "Disabled", use the app's terminology.
- **Use subagents for discovery.** The data model exploration is the heaviest part of this task. Parallelize it across discover analysis, backend business rules, frontend UI references, and the knowledge base.
- **The scenarios file is a contract.** Fixed values become hard assertions. Generated values become placeholder assertions. Make both intentional.
- **If context compaction occurs, re-read this prompt and use a TODO list.** Before compaction happens, write your current TODO list and progress to a scratchpad file. After compaction, immediately re-read this prompt, AUTONOMA.md, `discover.json`, and `scenarios.md`. Resume from your TODO list. This prevents losing track of progress.
- **Always run the validation checklist before finishing.** Phase 3.5 is mandatory. Do not skip it.
- **3 scenarios. Not 42.** If you find yourself creating more than 3 scenarios, you are over-segmenting. The `standard` scenario should cover 80%+ of test needs. The `empty` and `large` scenarios handle the remaining edge cases. That's it.

</details>
