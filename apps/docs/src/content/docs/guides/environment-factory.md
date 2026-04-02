---
title: Environment Factory Guide
description: How to implement the Autonoma Environment Factory in your application — a single signed POST endpoint for schema discovery, test data creation, and teardown.
---

:::note
This guide teaches you how to implement the Autonoma Environment Factory in your application, regardless of language or framework. For a complete working example in Next.js + Prisma, see the [Next.js Implementation](/examples/nextjs/).
:::

## The Big Picture

Before Autonoma runs an E2E test, it needs two things:

1. **Schema awareness** — what models, fields, and relationships exist
2. **Isolated data + authentication** — records for this run and a way to act as the test user

After the test finishes, everything gets cleaned up so the next test starts fresh.

Your job is to implement **one endpoint** that handles three actions:

| Action       | When it's called       | What you do |
| ------------ | ---------------------- | ----------- |
| **discover** | During planning/setup  | Return the schema metadata Autonoma needs to understand your data model |
| **up**       | Before each test run   | Create isolated data from an inline scenario recipe and return auth + teardown refs |
| **down**     | After each test run    | Verify the teardown token and remove the data created by `up` |

That's it. One endpoint, three actions, and the SDK handles the heavy lifting.

### Why "scenarios" still matter

Autonoma's planner still thinks in named scenarios such as `standard`, `empty`, and `large`. But the current SDK protocol doesn't require those names on the wire. Instead, the planner turns an approved scenario into an inline `create` recipe, sends that recipe to `up`, and relies on the Environment Factory to build and tear it down safely.

## How the Protocol Works

All communication is a single **POST** request with a JSON body. The `action` field tells your endpoint what to do. Every request is HMAC-signed with `x-signature`.

### Discover

Autonoma asks: "What does your database look like?"

**Request fields:**

| Field    | Type         | Description |
| -------- | ------------ | ----------- |
| `action` | `"discover"` | Always the string `"discover"` |

**Response fields:**

| Field                | Type   | Description |
| -------------------- | ------ | ----------- |
| `version`            | string | Protocol version |
| `sdk`                | object | SDK metadata (`language`, `orm`, `server`) |
| `schema`             | object | Schema metadata |
| `schema.models`      | array  | Models and their fields |
| `schema.edges`       | array  | Foreign key edges |
| `schema.relations`   | array  | Parent/child relation metadata |
| `schema.scopeField`  | string | Scope field used for isolation |

**Example:**

```json
// → POST /your-endpoint
{ "action": "discover" }

// ← 200 OK
{
  "version": "1.0",
  "sdk": {
    "language": "typescript",
    "orm": "prisma",
    "server": "express"
  },
  "schema": {
    "models": [
      {
        "name": "Organization",
        "fields": [
          {
            "name": "id",
            "type": "String",
            "isRequired": true,
            "isId": true,
            "hasDefault": true
          },
          {
            "name": "name",
            "type": "String",
            "isRequired": true,
            "isId": false,
            "hasDefault": false
          }
        ]
      }
    ],
    "edges": [
      {
        "from": "User",
        "to": "Organization",
        "localField": "organizationId",
        "foreignField": "id",
        "nullable": false
      }
    ],
    "relations": [
      {
        "parentModel": "Organization",
        "childModel": "User",
        "parentField": "users",
        "childField": "organizationId"
      }
    ],
    "scopeField": "organizationId"
  }
}
```

### Up

Autonoma says: "Create this isolated dataset for test run `run-abc123`."

**Request fields:**

| Field       | Type     | Description |
| ----------- | -------- | ----------- |
| `action`    | `"up"`   | Always the string `"up"` |
| `create`    | object   | Inline scenario definition: model name -> array of nested nodes |
| `testRunId` | string   | Optional unique identifier for this run. Use it for uniqueness; the SDK also injects it into template fields |

**Response fields:**

| Field        | Type   | Description |
| ------------ | ------ | ----------- |
| `version`    | string | Protocol version |
| `sdk`        | object | SDK metadata |
| `auth`       | object | Authentication material for the created user |
| `refs`       | object | All created records grouped by model |
| `refsToken`  | string | Signed teardown token for `down` |

**Example:**

```json
// → POST /your-endpoint
{
  "action": "up",
  "testRunId": "run-abc123",
  "create": {
    "Organization": [
      {
        "name": "Acme {{testRunId}}",
        "slug": "acme-{{testRunId}}",
        "users": [
          {
            "email": "admin-{{testRunId}}@example.com",
            "name": "Admin User"
          }
        ]
      }
    ]
  }
}

// ← 200 OK
{
  "version": "1.0",
  "sdk": {
    "language": "typescript",
    "orm": "prisma",
    "server": "express"
  },
  "auth": {
    "token": "eyJ..."
  },
  "refs": {
    "Organization": [
      { "id": "org_xyz", "name": "Acme run-abc123", "slug": "acme-run-abc123" }
    ],
    "User": [
      { "id": "usr_abc", "email": "admin-run-abc123@example.com", "organizationId": "org_xyz" }
    ]
  },
  "refsToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

### Down

Autonoma says: "I'm done with this run. Clean up everything created by `up`."

**Request fields:**

| Field       | Type     | Description |
| ----------- | -------- | ----------- |
| `action`    | `"down"` | Always the string `"down"` |
| `refsToken` | string   | The exact signed token returned by `up` |

**Response fields:**

| Field     | Type    | Description |
| --------- | ------- | ----------- |
| `version` | string  | Protocol version |
| `sdk`     | object  | SDK metadata |
| `ok`      | boolean | `true` if teardown completed |

**Example:**

```json
// → POST /your-endpoint
{
  "action": "down",
  "refsToken": "eyJhbGciOiJIUzI1NiIs..."
}

// ← 200 OK
{
  "version": "1.0",
  "sdk": {
    "language": "typescript",
    "orm": "prisma",
    "server": "express"
  },
  "ok": true
}
```

The server verifies the token and uses the signed refs inside it to determine what to delete. Clients should not craft arbitrary teardown refs.

## Security Model

Three layers of security protect your endpoint, using **two separate secrets** with very different purposes.

### The Two Secrets

Your implementation requires two secrets. They serve completely different purposes and must never be the same value.

| Secret | Recommended env var | Who knows it | Purpose |
| --- | --- | --- | --- |
| **Shared secret** | `AUTONOMA_SHARED_SECRET` | Both you **and** Autonoma | HMAC-SHA256 signature of every request. Proves the request came from Autonoma. |
| **Signing secret** | `AUTONOMA_SIGNING_SECRET` | **Only you** | Signs and verifies the teardown token (`refsToken`). Autonoma never sees this secret. |

**Generate both with `openssl`:**

```bash
# Generate the shared secret (give this to Autonoma too)
openssl rand -hex 32

# Generate the signing secret (keep this to yourself)
openssl rand -hex 32
```

Each command produces a 64-character hex string (256 bits of entropy). Run it twice and use a **different** value for each secret.

:::caution[Why two secrets?]
The **shared secret** proves that a request came from Autonoma. The **signing secret** proves that a `down` request is deleting data your own `up` action created. If you reused one secret for both, compromising the shared secret would also compromise teardown protection.
:::

### Layer 1: Environment Gating

Your endpoint should **not exist in production** unless explicitly enabled. The SDK supports this by blocking production unless you opt in.

This is the first line of defense. Even if someone discovers the URL, it doesn't respond in production by default.

### Layer 2: Request Signing (HMAC-SHA256)

Every request from Autonoma includes:

```text
x-signature: <hex-digest>
```

The signature is an HMAC-SHA256 of the **raw request body**, using `AUTONOMA_SHARED_SECRET`. Your endpoint must:

1. read the raw request body before JSON parsing
2. compute HMAC-SHA256 using the shared secret
3. compare your result with `x-signature`
4. reject if they don't match

### Layer 3: Signed Teardown Token

When `up` creates data, it signs the refs into a token (`refsToken`) using `AUTONOMA_SIGNING_SECRET`. Autonoma stores that token and sends it back when calling `down`. When `down` receives the token:

1. verify the token signature and expiry
2. decode the refs from inside the token
3. use those refs as the source of truth for teardown

This guarantees that `down` can only delete data that `up` actually created.

### Error Responses

Use consistent error codes so Autonoma can handle failures gracefully:

| Situation                          | HTTP Status | Error Code |
| ---------------------------------- | ----------- | ---------- |
| Unknown action                     | 400         | `UNKNOWN_ACTION` |
| Invalid request body               | 400         | `INVALID_BODY` |
| Invalid, expired, or mismatched token | 403      | `INVALID_REFS_TOKEN` |
| Missing or invalid HMAC signature  | 401         | `INVALID_SIGNATURE` |
| Endpoint blocked in production     | 404         | `PRODUCTION_BLOCKED` |

Response shape:

```json
{ "error": "Human-readable description", "code": "ERROR_CODE" }
```

## Implementing the Actions

<details>
<summary>Implementing Discover</summary>

This action returns the schema metadata Autonoma needs for planning.

Under the hood, the SDK introspects your database and returns:

- models
- fields
- FK edges
- relations
- scope field

If you're using an official adapter such as Prisma or Drizzle, you usually get this automatically.

</details>

<details>
<summary>Implementing Up</summary>

`up` receives an inline `create` recipe, resolves nested relations, creates the records in dependency order, and returns:

- auth
- refs
- refsToken

Important design decisions:

- **Every `up` creates a new isolated dataset.** Use `testRunId` and/or template helpers to keep unique fields unique across runs.
- **Collect all created IDs into `refs`.** Teardown depends on this.
- **Support nested create trees.** The SDK resolves FK ordering and many relation paths for you.
- **Keep generated fields generated.** If a planner marked a title or email as dynamic, keep it dynamic in the `create` recipe.

</details>

<details>
<summary>Implementing Down</summary>

`down` receives only the signed `refsToken`. It verifies the token and tears down records in a safe order based on the recorded refs and schema information.

This means callers do not need to send a free-form `refs` object back to your server, and your server does not need to trust user-supplied deletion targets.

</details>

## Validation Options

If you're validating scenario recipes locally, prefer the SDK helpers:

- `checkScenario`
- `checkAllScenarios`

These run the real `up` -> `down` lifecycle against your database and return structured errors. They are not a magical no-op; they perform real create-then-clean validation.

If you need to validate through HTTP instead, send signed `discover`, `up`, and `down` requests to your Environment Factory endpoint.

## Example: Express + Prisma

```ts
import { prismaAdapter } from '@autonoma-ai/sdk-prisma'
import { createExpressHandler } from '@autonoma-ai/server-express'

app.post('/api/autonoma', createExpressHandler({
  adapter: prismaAdapter(prisma, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
}))
```

That's it. The SDK handles signature verification, schema introspection, ordered creation, and teardown token verification for you.
