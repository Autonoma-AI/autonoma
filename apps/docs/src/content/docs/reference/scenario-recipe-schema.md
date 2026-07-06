---
title: Scenario Recipe Schema
description: Canonical JSON contract for the scenario recipes file uploaded to Autonoma at POST /v1/setup/setups/:id/scenario-recipe-versions.
---

This page documents the **canonical upload contract** for scenario recipes. It is language-agnostic: the schema is described as JSON with per-field expectations. The source of truth lives in `packages/types/src/schemas/scenarios.ts` (`ScenarioRecipesFileSchema`).

The file is posted as the JSON body of:

```
POST /v1/setup/setups/:setupId/scenario-recipe-versions
```

## Top-level shape

```json
{
  "version": 1,
  "source": {
    "discoverPath": "string",
    "scenariosPath": "string"
  },
  "validationMode": "sdk-check" | "endpoint-lifecycle",
  "recipes": [ /* at least one ScenarioRecipe */ ]
}
```

| Field            | Type                                          | Required | Notes |
|------------------|-----------------------------------------------|----------|-------|
| `version`        | integer, must equal `1`                       | yes      | Contract version. Currently only `1` is accepted. Not a string. |
| `source`         | object                                        | yes      | Provenance pointers. Additional keys are preserved. |
| `source.discoverPath`  | string                                  | yes      | Path (relative to the application repo) to the discovery output, e.g. `autonoma/discover.json`. **Required** - omitting it causes Zod to fail with `expected string, received undefined`. |
| `source.scenariosPath` | string                                  | yes      | Path to the human-readable scenarios document, e.g. `autonoma/scenarios.md`. |
| `validationMode` | `"sdk-check"` \| `"endpoint-lifecycle"`       | yes      | How Autonoma validated the recipes before upload. `sdk-check` = `checkScenario`/`checkAllScenarios`. `endpoint-lifecycle` = real HTTP `up`/`down`. |
| `recipes`        | array, minimum length `1`                      | yes      | One entry per scenario. See below. |

## `ScenarioRecipe` (one entry in `recipes[]`)

```json
{
  "name": "string",
  "description": "string",
  "create": { /* arbitrary model graph, see below */ },
  "variables": { /* optional, see below */ },
  "validation": {
    "status": "validated",
    "method": "checkScenario" | "checkAllScenarios" | "endpoint-up-down",
    "phase": "ok",
    "up_ms": 0,
    "down_ms": 0
  }
}
```

| Field                  | Type                                     | Required | Notes |
|------------------------|------------------------------------------|----------|-------|
| `name`                 | string                                   | yes      | Stable identifier. Must match the scenario name used in the LLM-facing docs. |
| `description`          | string                                   | yes      | Human-readable summary of the scenario state. |
| `create`               | object                                   | yes      | The model graph passed to the SDK's `createScenario` / `up` flow. A flat map: keys are model names, values are arrays of seeded rows. Rows link with `_alias` / `_ref` (no nesting). Extra keys are preserved. |
| `variables`            | object (map of name → definition)        | no       | Per-recipe dynamic values. See **Variable definitions** below. |
| `validation`           | object                                   | yes      | Proof that the recipe was validated. All fields must be present. |
| `validation.status`    | literal string `"validated"`             | yes      | |
| `validation.method`    | one of `"checkScenario"`, `"checkAllScenarios"`, `"endpoint-up-down"` | yes | Which validator produced this result. |
| `validation.phase`     | literal string `"ok"`                    | yes      | |
| `validation.up_ms`     | non-negative integer                     | no       | Milliseconds the `up` phase took. |
| `validation.down_ms`   | non-negative integer                     | no       | Milliseconds the `down` phase took. |

## Variable definitions

`variables` is a map from variable name to a **tagged union** discriminated by the `strategy` field. Exactly one of the three shapes below is valid per entry. Unknown `strategy` values are rejected.

### `literal`

Emits a fixed scalar on every run.

```json
{
  "strategy": "literal",
  "value": "admin@example.com"
}
```

| Field      | Type                               | Required | Notes |
|------------|------------------------------------|----------|-------|
| `strategy` | literal `"literal"`                | yes      | |
| `value`    | string \| number \| boolean \| null | yes      | Any JSON scalar. Objects and arrays are **not** allowed. |

### `derived`

Derives a deterministic value from the test run ID (so every invocation of the same test gets the same value, but different runs get different values).

```json
{
  "strategy": "derived",
  "source": "testRunId",
  "format": "user-{shortId}@example.com"
}
```

| Field      | Type                   | Required | Notes |
|------------|------------------------|----------|-------|
| `strategy` | literal `"derived"`    | yes      | |
| `source`   | literal `"testRunId"`  | yes      | Only `testRunId` is supported today. |
| `format`   | string                 | yes      | Template. The token `{shortId}` is replaced with a short hash of the run ID. |

### `faker`

Generates a fresh random value per run using Faker.

```json
{
  "strategy": "faker",
  "generator": "internet.email"
}
```

| Field       | Type                     | Required | Notes |
|-------------|--------------------------|----------|-------|
| `strategy`  | literal `"faker"`        | yes      | |
| `generator` | dotted Faker method path | yes      | e.g. `internet.email`, `person.firstName`, `commerce.productName`. |

## Full example

```json
{
  "version": 1,
  "source": {
    "discoverPath": "autonoma/discover.json",
    "scenariosPath": "autonoma/scenarios.md"
  },
  "validationMode": "sdk-check",
  "recipes": [
    {
      "name": "adminWithTwoProjects",
      "description": "Organization with an admin user and two projects.",
      "create": {
        "Organization": [{ "_alias": "org-1", "name": "Acme" }],
        "User": [
          {
            "email": "{adminEmail}",
            "role": "admin",
            "organizationId": { "_ref": "org-1" }
          }
        ],
        "Project": [
          { "name": "Alpha", "organizationId": { "_ref": "org-1" } },
          { "name": "Beta",  "organizationId": { "_ref": "org-1" } }
        ]
      },
      "variables": {
        "adminEmail": {
          "strategy": "derived",
          "source": "testRunId",
          "format": "admin-{shortId}@acme.test"
        }
      },
      "validation": {
        "status": "validated",
        "method": "checkScenario",
        "phase": "ok",
        "up_ms": 142,
        "down_ms": 61
      }
    }
  ]
}
```

## Common rejection reasons

- **`expected string, received undefined` under `source.discoverPath`** - the `source` object is missing `discoverPath`. Both `discoverPath` and `scenariosPath` are required.
- **Discriminated union error under `recipes[n].variables.<name>`** - an unknown or missing `strategy` key. Use exactly one of `"literal"`, `"derived"`, `"faker"`.
- **`version` must be literal `1`** - don't send `"1"` or `"1.0"`. Integer `1`.
- **`recipes` must contain at least 1 element** - empty arrays are rejected.
- **`validation.status` / `validation.phase` mismatch** - both are fixed literals (`"validated"` / `"ok"`). Any other value fails.

## Related

- [Test Planner](/test-planner/) - how scenarios are designed and recipes are validated before upload.
- [Environment Factory](/environment-factory/) - the `up` / `down` / `discover` SDK that consumes these recipes at runtime.
