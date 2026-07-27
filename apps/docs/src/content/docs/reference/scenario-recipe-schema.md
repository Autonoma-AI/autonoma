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
| `variables`            | object (map of name → definition)        | no       | **Deprecated.** Still accepted for recipes that already declare it, but no longer generated or documented. Use the built-in tokens below instead. |
| `validation`           | object                                   | yes      | Proof that the recipe was validated. All fields must be present. |
| `validation.status`    | literal string `"validated"`             | yes      | |
| `validation.method`    | one of `"checkScenario"`, `"checkAllScenarios"`, `"endpoint-up-down"` | yes | Which validator produced this result. |
| `validation.phase`     | literal string `"ok"`                    | yes      | |
| `validation.up_ms`     | non-negative integer                     | no       | Milliseconds the `up` phase took. |
| `validation.down_ms`   | non-negative integer                     | no       | Milliseconds the `down` phase took. |

## Built-in tokens

Every value in `create` must be concrete, with exactly two exceptions. These tokens are written in **double braces** and need no declaration - Autonoma substitutes them when it provisions the scenario.

| Token                | Value |
|----------------------|-------|
| `{{testRunId}}`      | The id of this provisioning run - the same value Autonoma sends the Environment Factory as the `up` request's `testRunId`, so your recipe and your handler agree on one identity. |
| `{{testRunShortId}}` | An 8-character hash of `{{testRunId}}`, for columns too short to hold a UUID (usernames, slugs, subdomains). |

They exist for one reason: concurrent runs of the same scenario would otherwise collide on unique columns. Use them anywhere a value must be unique per run, including inside a longer string.

```json
"User": [
  {
    "_alias": "admin",
    "email": "admin-{{testRunShortId}}@acme.test",
    "externalId": "{{testRunId}}"
  }
]
```

Any other `{{token}}` is rejected on upload - there is no general variable mechanism.

:::caution[Deprecated: the `variables` block]
Recipes could once declare a `variables` map of `literal` / `derived` / `faker` definitions. Autonoma still resolves it for recipes that already carry one, but it is no longer generated and should not be added to new recipes. The two built-in tokens above cover the only case it was needed for.
:::

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
            "email": "admin-{{testRunShortId}}@acme.test",
            "role": "admin",
            "organizationId": { "_ref": "org-1" }
          }
        ],
        "Project": [
          { "name": "Alpha", "organizationId": { "_ref": "org-1" } },
          { "name": "Beta",  "organizationId": { "_ref": "org-1" } }
        ]
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
- **`Unknown recipe variable: <name>`** - the `create` graph uses a `{{token}}` that is not one of the two built-ins. Replace it with a concrete value.
- **`These _ref targets match no _alias in the graph`** - a row references an alias no row declares. Add the `_alias`, or drop the reference.
- **`The create graph must map each model name to an array of records`** - a model maps to a scalar or a bare array of non-objects. The Environment Factory rejects the whole seed in that shape.
- **`version` must be literal `1`** - don't send `"1"` or `"1.0"`. Integer `1`.
- **`recipes` must contain at least 1 element** - empty arrays are rejected.
- **`validation.status` / `validation.phase` mismatch** - both are fixed literals (`"validated"` / `"ok"`). Any other value fails.

## Related

- [Test Planner](/test-planner/) - how scenarios are designed and recipes are validated before upload.
- [Environment Factory](/environment-factory/) - the `up` / `down` / `discover` SDK that consumes these recipes at runtime.
