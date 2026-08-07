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

There are exactly two dynamic values, and every field that must be UNIQUE per test
run has to carry one of them:
- {{${TEST_RUN_ID_TOKEN}}} - the id of the run being seeded
- {{${TEST_RUN_SHORT_ID_TOKEN}}} - an 8-character hash of it, for short columns

An email, a username, a slug, a subdomain, an account number, an external reference -
anything the database will refuse a second copy of - must embed a token INSIDE an
otherwise real-looking value ("admin+{{${TEST_RUN_ID_TOKEN}}}@acme.test",
"acme-{{${TEST_RUN_SHORT_ID_TOKEN}}}"), never replace the value entirely. Two tests
run at the same time seed this scenario twice; without the token the second one fails
on a unique constraint. No other {{token}} or bare {variable} exists - inventing one
is rejected.

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
