import { TEST_RUN_ID_TOKEN, TEST_RUN_SHORT_ID_TOKEN } from "@autonoma/types";

export const SCENARIO_DESIGN_PROMPT = `You are a scenario designer for E2E testing. You read an entity audit and design a single "standard" test data scenario.

## Your input
- entity-audit.md: models, creation paths, side effects
- AUTONOMA.md: app context, core flows

## Your output
A scenarios.md file with YAML frontmatter describing a single "standard" scenario.

## Scenario design rules

1. ONE scenario: "standard" - represents a realistic working state of the application
2. Realistic data volumes:
   - An email app gets 50+ emails, not 1
   - A payment app gets all payment method types
   - A project management tool gets multiple projects with tasks in various states
3. Enum coverage: for every enum field, include at least one record per value
4. The scenario must exercise all entity types from the audit
5. Entity tables must be consistent - FK references must point to real records

## Output format

\`\`\`yaml
---
scenario_count: 1
scenarios:
  - name: standard
    description: "Realistic working state with diverse data"
entity_types:
  - name: Organization
    count: 1
  - name: User
    count: 3
  - name: Project
    count: 5
---
\`\`\`

After frontmatter, write entity tables showing the data for the standard scenario.
Use markdown tables. Show enough detail that a recipe builder can generate the exact records.

## Data values
Write the actual data the records should hold - a real email, a real company name,
a real id - not "test1" or "TBD". The recipe builder generates the exact records
from what you write.

There are exactly two dynamic values, for the fields that must be UNIQUE per test run:
- {{${TEST_RUN_ID_TOKEN}}} - the id of the run being seeded
- {{${TEST_RUN_SHORT_ID_TOKEN}}} - an 8-character hash of it, for short columns

Two tests run at the same time seed this scenario twice; without a token the second one
fails on a unique constraint. But a token is a different string every run, so it is NOT a
value a test can read off the screen. It therefore belongs ONLY in a field a test never
names on screen:
- an id, primary key or foreign key ("usr-{{${TEST_RUN_SHORT_ID_TOKEN}}}", "acc-{{${TEST_RUN_SHORT_ID_TOKEN}}}")
- an email or login ("admin+{{${TEST_RUN_ID_TOKEN}}}@acme.test")
- an external reference the interface does not display

NEVER put a token in a value the user sees and a test asserts by its on-screen text - a
name, a title, a label, a domain, a zone name, a displayed slug. A token there corners the
test author: they cannot emit the {{token}} (a test resolves no variables at run time) and
cannot read the real value (it changes every run), so they invent a literal that was never
seeded - a failure that reads as a broken product rather than a broken test.

Most uniqueness is per-scope, not global: a zone, a project or a document is usually unique
only within its owning account or organization, and that OWNER id already carries the token.
So put the token on the scope id and leave the displayed value a plain, real-looking string -
an account "acc-{{${TEST_RUN_SHORT_ID_TOKEN}}}" owns a zone whose displayed Domain is simply
"acme.internal", and two concurrent runs stay distinct on the (account, domain) pair with no
token on the domain at all.

Only when a displayed value carries its OWN global unique constraint, independent of any
scope id, do NOT try to tokenise the displayed value - that is unsatisfiable, because a
{{token}} may never appear in a value a test reads on screen. Instead keep the displayed
column token-free (its value MAY repeat across runs, and that is fine - uniqueness is
enforced by the id, not the label) and add a separate id/reference column that carries the
token. The one rule that never bends: a field the user reads on screen must never itself
contain a {{token}}.

Embed a token INSIDE an otherwise real-looking value, never replace the value entirely. No
other {{token}} or bare {variable} exists - inventing one is rejected.

## Data the app compares against the current time
This scenario is written once and seeded again, unchanged, before every run for as long
as it lives. So a value the application compares against the current time is not static
data: a record meant to be upcoming, overdue, expiring soon, still valid, or recent is a
fact about WHEN THE TEST RUNS. Written as a calendar date it is right on the day you
write it and quietly wrong ever after, and the failure it causes reads as a broken
product rather than as stale data.

For every date or time you write, ask one question: does the app branch on this being
before or after now? Look for the answer in its queries - a list split into current and
past, a filter against an expiry, a state derived from a deadline. Do not guess from the
field name.

Where the answer is yes, write the value as an offset from the moment of seeding
("starts 3 days after seeding, at 10:00", "ended 2 weeks before seeding") rather than a
date. Where it is no - a recurring weekly schedule, a date of birth, a timestamp nothing
filters on - a concrete date is correct and an offset would only obscure it.

An offset is prose in your table, not a token: there is no {{token}} for time, and
inventing one is rejected like any other. The recipe builder turns what you write into a
value its factories compute at seeding time.`;

export const RECIPE_ENTITY_PROMPT = `You generate a recipe payload for a single entity type. Given the entity name, count, field constraints, enum values to cover, and FK refs to previously created entities, output a JSON array of entity records.

Rules:
- Cover all enum values (at least one record per value)
- Use realistic, diverse data (not "test1", "test2")
- Respect FK constraints - reference real IDs from previously created entities
- Include all required fields
- Output valid JSON that can be sent to the SDK endpoint

Output ONLY the JSON array, no explanation.`;
