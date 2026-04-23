---
title: Environment Factory Guide
description: How to set up the Autonoma Environment Factory in your application using the SDK — a single POST endpoint for creating and destroying isolated test environments.
---

:::note
This guide covers the SDK-based setup for the Environment Factory. For framework-specific examples, see [Examples](/examples/) — covering TypeScript, Python, Elixir, Java, Ruby, Rust, Go, and PHP.
:::

## The Big Picture

Before Autonoma runs an E2E test, it needs two things:

1. **Data** — a user account, some test records, whatever the test scenario requires
2. **Authentication** — a way to log in as that user (cookies, headers, or credentials)

After the test finishes, everything gets cleaned up so the next test starts fresh.

You set up **one endpoint** that the Autonoma SDK handles for you. It responds to three actions:

| Action       | When it's called               | What happens                                                           |
| ------------ | ------------------------------ | ---------------------------------------------------------------------- |
| **discover** | When Autonoma connects         | Returns your database schema (models, fields, relationships)           |
| **up**       | Before each test run           | Creates data from a structured tree, generates auth credentials        |
| **down**     | After each test run            | Verifies the signed token and deletes only the data that was created   |

The SDK reads your ORM schema, handles FK ordering, injects scope fields, creates entities, signs teardown tokens, and manages the full lifecycle. You configure the adapter, register factories for every model that has a dedicated create function in your codebase, and implement an auth callback.

## How the Protocol Works

All communication is a single **POST** request with a JSON body. The `action` field determines the operation. Every request is HMAC-SHA256 signed.

### Discover

Autonoma asks: "What does your database look like?"

**Request:**

```json
{ "action": "discover" }
```

**Response:**

```json
{
  "version": "1.0",
  "sdk": { "language": "typescript", "orm": "prisma", "server": "web" },
  "schema": {
    "models": [
      { "name": "Organization", "fields": [{ "name": "id", "type": "String", "isId": true }, { "name": "name", "type": "String" }] },
      { "name": "User", "fields": [{ "name": "id", "type": "String", "isId": true }, { "name": "email", "type": "String" }] }
    ],
    "edges": [
      { "from": "Member", "to": "Organization", "localField": "organizationId", "foreignField": "id" },
      { "from": "Member", "to": "User", "localField": "userId", "foreignField": "id" }
    ],
    "relations": [
      { "parentModel": "Organization", "childModel": "Member", "parentField": "members", "childField": "organization" }
    ],
    "scopeField": "organizationId"
  }
}
```

The schema contains:
- **models**: every database model with their fields (name, type, required, id, hasDefault)
- **edges**: every FK relationship (from model, to model, local field, foreign field, nullable)
- **relations**: named relation mappings used for scenario nesting
- **scopeField**: the field name used for test data isolation (e.g., `organizationId`)

### Up

Autonoma says: "Create this data for a test run."

**Request:**

```json
{
  "action": "up",
  "testRunId": "run-abc123",
  "create": {
    "Organization": [{
      "name": "Acme Corp",
      "slug": "acme-corp",
      "members": [{
        "role": "owner",
        "user": [{ "name": "Alice", "email": "alice-run-abc123@test.com" }]
      }]
    }]
  }
}
```

The `create` field is a nested JSON tree. The SDK reads your schema and automatically:
- Creates entities in FK-safe order (parents before children)
- Injects the scope field value into all child records
- Wires FK references from the nesting structure
- Resolves cross-branch references (`_alias` / `_ref`)

**Response:**

```json
{
  "version": "1.0",
  "sdk": { "language": "typescript", "orm": "prisma", "server": "web" },
  "auth": {
    "cookies": [{
      "name": "session",
      "value": "eyJ...",
      "httpOnly": true,
      "sameSite": "lax",
      "path": "/"
    }]
  },
  "refs": {
    "Organization": [{ "id": "org_xyz", "name": "Acme Corp" }],
    "User": [{ "id": "usr_abc", "email": "alice-run-abc123@test.com" }],
    "Member": [{ "id": "mem_123" }]
  },
  "refsToken": "header.payload.signature"
}
```

- **auth**: credentials the test runner uses to authenticate (from your auth callback)
- **refs**: all created records, keyed by model name
- **refsToken**: a signed token encoding the created record IDs, used for safe teardown

### Down

Autonoma says: "I'm done — delete what you created."

**Request:**

```json
{
  "action": "down",
  "refsToken": "header.payload.signature"
}
```

The `refsToken` is the exact token from the `up` response. The SDK verifies the signature, extracts the record IDs, and deletes them in reverse topological order.

**Response:**

```json
{
  "version": "1.0",
  "sdk": { "language": "typescript", "orm": "prisma", "server": "web" },
  "ok": true
}
```

## Security Model

Three layers of security protect your endpoint, using **two separate secrets** with different purposes.

### The Two Secrets

| Secret | Env Variable | Who knows it | Purpose |
| --- | --- | --- | --- |
| **Shared secret** | `AUTONOMA_SHARED_SECRET` | You + Autonoma | HMAC-SHA256 signature on every request. Autonoma signs; your SDK verifies. You paste this into the Autonoma dashboard. |
| **Signing secret** | `AUTONOMA_SIGNING_SECRET` | Only you | Signs the `refsToken` during `up`, verifies during `down`. Autonoma stores the token opaquely — it cannot read or modify it. |

The two secrets **must be different values**. The SDK throws an error at startup if they match.

**Generate with `openssl`:**

```bash
openssl rand -hex 32   # → use as AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # → use as AUTONOMA_SIGNING_SECRET (must be different!)
```

### Layer 1: Production Guard

The endpoint returns **404** when the application is running in production mode (`NODE_ENV=production` or equivalent), unless explicitly opted in with `allowProduction: true`. Even if someone discovers the URL, it doesn't respond in production.

### Layer 2: Request Signing (HMAC-SHA256)

Every request from Autonoma includes a signature header:

```
x-signature: <hex-digest>
```

The signature is HMAC-SHA256 of the raw request body, keyed with the **shared secret**. The SDK verifies this automatically — unsigned or tampered requests are rejected with 401.

### Layer 3: Signed Refs Token

When `up` creates data, the SDK signs all created record IDs into a token (`refsToken`) using the **signing secret**. During `down`, the SDK verifies this token before deleting anything.

This guarantees that `down` can only delete data that `up` actually created. Even Autonoma cannot forge or modify this token — it just stores the opaque string and passes it back.

| Attack | Why it fails |
| --- | --- |
| Attacker sends fake refs with made-up IDs | No valid token → rejected |
| Attacker sends a valid token but changes the refs | Refs don't match token → rejected |
| Attacker replays a token from a week ago | Token expired (24h) → rejected |

### What the SDK Can and Cannot Do

The SDK enforces hard safety constraints:

- **UP can only CREATE** — it calls ORM create methods. It cannot UPDATE, DELETE, DROP, TRUNCATE, or run raw SQL. The worst it can do is INSERT rows.
- **DOWN can only DELETE what UP created** — verified by the signed refs token. It deletes only the records listed in the token, in reverse FK order.
- **No raw SQL** — all operations go through the ORM layer. Schema validation happens at the ORM level.

### Error Codes

| Code | HTTP Status | Meaning |
| --- | --- | --- |
| `INVALID_SIGNATURE` | 401 | HMAC signature missing or does not match |
| `INVALID_BODY` | 400 | Request body is not valid JSON, or missing required fields |
| `UNKNOWN_ACTION` | 400 | The action field is not discover, up, or down |
| `INVALID_REFS_TOKEN` | 403 | The refs token is missing, malformed, or signature verification failed |
| `PRODUCTION_BLOCKED` | 404 | Endpoint is disabled in production mode |
| `SAME_SECRETS` | 500 | sharedSecret and signingSecret are the same value |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

## Setting Up the SDK

### 0. Integrate into your existing backend — never a sidecar

The endpoint lives inside **your existing backend application**, alongside your other routes. It is not a separate server, sidecar, or standalone process.

Pick the SDK in the **same language as your backend**:

| Your backend language | Manifest file | SDK package |
|----------------------|---------------|-------------|
| TypeScript / JavaScript | `package.json` | `@autonoma-ai/sdk` |
| Python | `pyproject.toml` / `requirements.txt` | `autonoma-sdk` |
| Go | `go.mod` | `github.com/autonoma-ai/autonoma-sdk-go` |
| Rust | `Cargo.toml` | `autonoma` crate |
| Java | `pom.xml` / `build.gradle` | `ai.autonoma:autonoma-sdk` |
| Ruby | `Gemfile` / `*.gemspec` | `autonoma` gem |
| PHP | `composer.json` | `autonoma/sdk` |
| Elixir | `mix.exs` | `autonoma` hex package |

If your backend is in a language without a matching SDK, open an issue — do not spin up a polyglot sidecar. Running a Python `FastAPI` next to a NestJS app so you can use the Python SDK will silently drift from your production code (auth flows, hashing, hooks, triggers) and create maintenance headaches.

Backend directory detection: scan for the manifest file above. Real projects use many conventions — `backend/`, `server/`, `api/`, `apps/api/`, `services/core/`, `core-app-backend/`, etc. — so don't assume the directory is named `backend/`.

### 1. Install

Pick the packages that match your stack:

**Next.js App Router + Prisma** (most common):
```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/sdk-prisma @autonoma-ai/server-web
```

**Express + Prisma**:
```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/sdk-prisma @autonoma-ai/server-express
```

**Hono / Bun / Deno + Drizzle**:
```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/sdk-drizzle @autonoma-ai/server-web
```

**Node.js http + Prisma**:
```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/sdk-prisma @autonoma-ai/server-node
```

#### Package reference

| Your ORM | Package |
|----------|---------|
| Prisma | `@autonoma-ai/sdk-prisma` |
| Drizzle | `@autonoma-ai/sdk-drizzle` |

| Your Framework | Package |
|----------------|---------|
| Next.js App Router, Hono, Bun, Deno | `@autonoma-ai/server-web` |
| Express, Fastify | `@autonoma-ai/server-express` |
| Node.js http | `@autonoma-ai/server-node` |

### 2. Find your scope field

Open your Prisma schema (or Drizzle schema). Look for the FK that most models use to reference a root entity:

```prisma
model User {
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
}

model Application {
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])
}
```

If most models have `organizationId` (or `orgId`, `tenantId`, `workspaceId`), that's your scope field.

**Important**: The scope root model (usually `Organization`) does NOT have this field on itself. The SDK knows this — it reads the FK graph and only injects the scope field into models that have it as a column.

### 3. Generate secrets

You need two **different** secrets. The SDK throws an error if they are the same.

```bash
openssl rand -hex 32   # → use as AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # → use as AUTONOMA_SIGNING_SECRET (must be different!)
```

Add to `.env`:

```env
AUTONOMA_SHARED_SECRET=abc123...   # share this with Autonoma
AUTONOMA_SIGNING_SECRET=def456...  # keep this private, never share
```

### 4. Create the endpoint

#### Next.js App Router

```typescript
// app/api/autonoma/route.ts
import { createHandler } from '@autonoma-ai/server-web'
import { prismaAdapter } from '@autonoma-ai/sdk-prisma'
import { prisma } from '@/lib/db'

export const POST = createHandler({
  adapter: prismaAdapter(prisma, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  auth: async (user) => {
    // Create a real session for this user — see section 5
    const session = await createSession(user.id as string)
    return {
      cookies: [{ name: 'session', value: session.token, httpOnly: true, sameSite: 'lax', path: '/' }],
    }
  },
})
```

#### Express

```typescript
// routes/autonoma.ts
import { createExpressHandler } from '@autonoma-ai/server-express'
import { prismaAdapter } from '@autonoma-ai/sdk-prisma'
import { prisma } from '../db'

app.post('/api/autonoma', createExpressHandler({
  adapter: prismaAdapter(prisma, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  auth: async (user) => {
    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET!)
    return { token }
  },
}))
```

#### Hono

```typescript
// src/routes/autonoma.ts
import { createHandler } from '@autonoma-ai/server-web'
import { prismaAdapter } from '@autonoma-ai/sdk-prisma'
import { prisma } from '../db'

const handler = createHandler({
  adapter: prismaAdapter(prisma, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  auth: async (user) => {
    const token = await createToken(user.id as string)
    return { token }
  },
})

app.post('/api/autonoma', (c) => handler(c.req.raw))
```

#### Drizzle + Express

```typescript
import { createExpressHandler } from '@autonoma-ai/server-express'
import { drizzleAdapter } from '@autonoma-ai/sdk-drizzle'
import { db } from '../db'
import * as schema from '../db/schema'

app.post('/api/autonoma', createExpressHandler({
  adapter: drizzleAdapter(db, schema, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  auth: async (user) => {
    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET!)
    return { token }
  },
}))
```

### 5. Implement the auth callback

The `auth` callback receives the first `User` record created during `up`. It must return real, working credentials that the test runner can use to authenticate with your app.

**This is critical.** If the auth callback returns fake or expired tokens, every test will fail at the login step.

#### What the callback receives

```typescript
auth: async (user) => {
  // user is the first User record from the scenario, e.g.:
  // { id: 'clxyz...', name: 'Admin', email: 'admin-abc123@test.com', ... }
}
```

#### What the callback must return

```typescript
interface AuthResult {
  token?: string                    // Bearer token
  cookies?: Array<{                 // Session cookies
    name: string
    value: string
    httpOnly?: boolean
    sameSite?: string
    path?: string
  }>
  headers?: Record<string, string>  // Custom auth headers
  credentials?: {                   // Email/password for manual login
    email: string
    password: string
  }
}
```

#### Pattern 1: Session cookies (most web apps)

```typescript
auth: async (user) => {
  const session = await lucia.createSession(user.id as string, {})
  const cookie = lucia.createSessionCookie(session.id)
  return {
    cookies: [{
      name: cookie.name,
      value: cookie.value,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    }],
  }
}
```

#### Pattern 2: JWT bearer token (APIs, SPAs)

```typescript
auth: async (user) => {
  const token = jwt.sign(
    { sub: user.id, email: user.email },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  )
  return { token }
}
```

#### Pattern 3: Email/password (mobile apps)

When the test runner needs to log in through the UI, return credentials instead of a token:

```typescript
auth: async (user) => ({
  credentials: {
    email: user.email as string,
    password: 'test-password-123',
  },
})
```

**Important**: For this to work, the User must be created with a known password. Use a factory to hash the password during creation.

:::caution[Mobile apps: use credentials only]
For **iOS and Android** applications, cookies and headers are **not supported**. Autonoma cannot inject them into native mobile apps. Use **credentials** and return email/password for the agent to log in through your app's login screen.
:::

#### Common auth mistakes

| Mistake | What happens | Fix |
|---------|-------------|-----|
| Returning a hardcoded string like `"test-token"` | Every test fails at login | Use your real session/JWT creation |
| Not setting password on the User record | Email/password login fails | Use a factory that hashes passwords |
| Token expires too quickly | Tests fail midway | Set expiration to at least 1 hour |
| Wrong cookie name | Browser doesn't send the cookie | Check your app's cookie name in DevTools |

### 6. Register factories

Register a **factory** for every model in your codebase that has a dedicated create function (service, repository, or similar helper). This is the default — even for thin wrappers.

**Why factory-by-default?** If you already have `ProjectService.create()` that today just wraps `prisma.project.create()`, wire it up anyway. The day you add an audit log, a Stripe sync, or a cache write to that function, your tests keep working — zero rewiring. Raw SQL can never run that new logic.

Models without a dedicated create function (only inline ORM calls scattered across route handlers, or no create path at all) fall back to raw SQL INSERT automatically. Use the [Step 2 Entity Audit](/test-planner/step-2-entity-audit/) to classify every model: roots (`independently_created: true`) get a factory, pure dependents (`independently_created: false`, non-empty `created_by`) come along with their owner's factory and don't need one of their own.

```typescript
import { defineFactory } from '@autonoma-ai/sdk'

const handler = createExpressHandler({
  adapter: prismaAdapter(prisma, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  factories: {
    Organization: defineFactory({
      create: async (data, ctx) => {
        // Use your real service/repository — business logic included
        return organizationService.create({
          name: data.name as string,
          slug: data.slug as string,
        })
      },
      teardown: async (record, ctx) => {
        await organizationService.delete(record.id as string)
      },
    }),
    User: defineFactory({
      create: async (data, ctx) => {
        // Password hashing, email normalization, etc.
        return userService.create({
          email: data.email as string,
          name: data.name as string,
          password: 'test-password-123', // known password for auth
        })
      },
      // No teardown — SQL DELETE fallback handles it
    }),
    // Models without a dedicated create function fall back to raw SQL INSERT automatically
  },
  auth: async (user) => { /* ... */ },
})
```

#### Model name ↔ table name (populating `tableNameMap` sparsely)

The SDK reads your SQL tables and derives a model name for each one by splitting on `_` and PascalCasing the parts. **There is no pluralization step.** `organization` becomes `Organization`; `organizations` stays `Organizations`; `api_key` becomes `ApiKey`; `api_keys` stays `ApiKeys`.

Factories are keyed by model name. If every factory key matches its auto-derived name, you don't pass `tableNameMap` at all — the SDK's derivation is exact and complete.

You only pass `tableNameMap` when a factory key disagrees with the auto-derived name. **The map is sparse: list only the entries that differ, not every model.** Auto-derivation covers the rest.

Algorithm the agent should follow when wiring the handler:

1. List every factory key you intend to register.
2. For each key, compute `autoName = snakeToPascal(dbTable)` — split the table name on `_`, PascalCase each part, concat. No pluralization.
3. If `autoName === factoryKey`: skip. Do not add to `tableNameMap`.
4. If `autoName !== factoryKey`: add the entry to `tableNameMap`.
5. If after step 4 the map is empty, **omit the `tableNameMap` field entirely**.

```ts
// DB has singular tables: organization, user, api_key, deal
// Factory keys: Organization, User, ApiKey, Deal
// Every auto-derived name matches → omit tableNameMap.
createHandler({
  // ...
  factories: { Organization: ..., User: ..., ApiKey: ..., Deal: ... },
})

// DB has plural tables: organizations, users, api_keys
// Factory keys singular → every entry disagrees.
createHandler({
  // ...
  tableNameMap: {
    Organization: 'organizations',
    User: 'users',
    ApiKey: 'api_keys',
  },
  factories: { Organization: ..., User: ..., ApiKey: ... },
})
```

**Red flag — matching registries.** If `tableNameMap` has exactly one entry per factory and every entry is a plural↔singular rename, you've written the same information twice. Two options:

- Keep the map (verbose but explicit).
- Change your factory keys to the plural auto-derived names (`Organizations`, `Users`) and drop the map.

Pick the second unless your scenario files already use the singular convention. A `tableNameMap` that is a 1:1 copy of your factory registry is a foot-gun: adding a new model requires editing two places or it breaks silently.

#### How factories work

1. The SDK resolves the create tree and topologically sorts entities
2. For each model in order: if a factory is registered, the SDK calls `factory.create()` per record; otherwise it uses raw SQL INSERT
3. **Factory receives pre-resolved fields** — FK references and temp IDs are already replaced with real IDs. The factory never sees `__temp_*` values.
4. **Factory must return at least the primary key** (e.g., `{ id: "..." }`). All returned fields are stored in refs and available to subsequent factories via `ctx.refs`.
5. On teardown: if a factory defines `teardown`, it's called per record in reverse order; otherwise the SDK falls back to SQL DELETE.

#### When to register a factory

The rule is structural, not behavioral: does your codebase have a dedicated create function for this model?

| Situation | Use factory? |
| --- | --- |
| A `create`/`insert`/`register` function exists in a service or repository | **Yes** — always, even if it's a thin wrapper |
| A function exists and also hashes passwords, generates slugs, syncs to Stripe, etc. | **Yes** |
| The only create path is inline `prisma.tag.create()` calls scattered across route handlers | No — raw SQL fallback |
| The model is never created at all in application code (e.g., a seed-only lookup table) | No — raw SQL fallback |

The entity audit (Step 2) makes this decision for you and writes it to `autonoma/entity-audit.md`. The implement step reads that file and registers one factory per model marked `independently_created: true`. Pure dependents are never given their own factory — see [Dependents, cascades, and teardown](#dependents-cascades-and-teardown) below for how they come and go.

#### Dependents, cascades, and teardown

A root can mint dependent rows inline — e.g. `<Root>Service.create` may insert a root row plus a default child, a grandchild, and an onboarding row, all in one transaction. Step 2 records each dependent with a `created_by: [{owner, via, why}]` pointing back at the owner. The SDK does not automatically know about those rows; you have to tell it how to tear them down. Four options, in preference order:

1. **Schema cascade** — the FK chain from every dependent back to the root is `onDelete: Cascade` (Prisma) / `ON DELETE CASCADE` (raw SQL). Deleting the root row is enough; the DB handles the rest. Nothing to configure on the factory. This is the easiest case and usually the intent when the production code mints everything in one transaction.
2. **Call the app's delete function** — if your codebase already has a delete method that tears down the same subtree (e.g. a `<Root>Service.delete` that removes the root and every dependent it minted), register `teardown` on the root's factory to call it:

   ```typescript
   <Root>: defineFactory({
     create: async (data, ctx) => <Root>Service.create(data, { executor: ctx.executor }),
     teardown: async (record) => <Root>Service.delete(record.id as string),
   }),
   ```

3. **Forward dependent IDs that the production `create` already returns** — if the production `create` function returns the dependent IDs in its result (e.g. `{ root, child, grandchild }`), surface those IDs from the factory so they land in refs, and write a `teardown` that deletes them in reverse FK order:

   ```typescript
   <Root>: defineFactory({
     create: async (data, ctx) => {
       const { root, child, grandchild } = await <Root>Service.create(data, { executor: ctx.executor });
       return { id: root.id, childId: child.id, grandchildId: grandchild.id };
     },
     teardown: async (record, ctx) => {
       await ctx.executor.<grandchild>.delete({ where: { id: record.grandchildId } });
       await ctx.executor.<child>.delete({ where: { id: record.childId } });
       await ctx.executor.<root>.delete({ where: { id: record.id } });
     },
   }),
   ```

4. **None of the above — STOP.** Do NOT modify your production service to return more IDs than it already does just to satisfy the test harness. Adding test-only return values to production code inverts the relationship we want (tests adapt to production, not the other way around). Instead, report the gap: add a cascade to the schema, add a delete function to the service, or accept orphans between runs (acceptable when the test database is reset periodically).

Pure dependents (`independently_created: false`) never have their own factory or teardown — they always come and go with their owner.

#### Factory context

Both `create` and `teardown` receive a context object:

```typescript
interface FactoryContext {
  refs: Record<string, Record<string, unknown>[]>  // all records created so far
  executor: SQLExecutor                             // for direct DB access if needed
  scenarioName: string
  testRunId: string
}
```

## The Create Tree Format

The `create` field in `up` requests is a nested JSON tree. Top-level keys are model names. Children are nested inside their parents using the relation field name from your ORM schema.

### How nesting works

The SDK reads your ORM schema's relations to know what each nested key means. The nested key must match the exact relation field name from the parent model.

```json
{
  "create": {
    "Organization": [{
      "name": "Acme Corp",
      "members": [{
        "role": "owner",
        "user": [{ "name": "Alice", "email": "alice@test.com" }]
      }]
    }]
  }
}
```

This creates:
1. One Organization
2. One User (created first because Member holds the FK to it)
3. One Member with `organizationId` set to the Organization's ID and `userId` set to the User's ID

The SDK handles both FK directions automatically:
- **FK on child** (most common): `Application.organizationId` → Organization is created first, then Application with `organizationId` set
- **FK on parent** (reverse): `Member.userId` → User is created first, then Member gets `userId` set

### What to include in fields

- **Required fields** without defaults that are not auto-generated
- **Unique fields** with values unique per test run (use `testRunId` in emails, slugs, etc.)

### What to omit

- **id** — auto-generated by the database
- **Fields with defaults** — the database or ORM handles them
- **Auto-updated timestamps** — `updatedAt` is handled by the ORM
- **FK fields handled by nesting** — if you nest Application under Organization, don't set `organizationId` manually
- **The scope field** — the SDK injects it automatically

### Cross-branch references (`_alias` / `_ref`)

When a record needs a FK to something in a different branch of the tree, use `_alias` to name a node and `_ref` to reference it:

```json
{
  "create": {
    "Organization": [{
      "name": "Acme Corp",
      "applications": [{
        "_alias": "webApp",
        "name": "Marketing Website",
        "architecture": "WEB",

        "testPlans": [{
          "name": "Smoke Plan",
          "plan": "content",
          "testGenerations": [{
            "_alias": "gen1",
            "conversation": "[]",
            "status": "success",
            "applicationId": { "_ref": "webApp" }
          }]
        }],

        "tests": [{
          "name": "Homepage Test",
          "testGenerationId": { "_ref": "gen1" },
          "steps": [
            { "order": 1, "interaction": "click", "params": {} }
          ]
        }]
      }]
    }]
  }
}
```

Rules:
- `_alias` is a string name you choose. It must be unique across the entire scenario.
- `_ref` resolves to the `id` of the aliased node after it's created.
- The aliased node must appear before the `_ref` in depth-first traversal order.

## Validating the Lifecycle

After setting up the endpoint, validate that `up` creates the correct data and `down` cleans it up completely. **This must happen before writing tests** — it catches bad assumptions about scenario data early.

### Smoke test with curl

```bash
SECRET="your-shared-secret-here"
URL="http://localhost:3000/api/autonoma"
BODY='{"action":"discover"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/.*= //')
curl -s -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "x-signature: $SIG" \
  -d "$BODY" | jq .
```

**Expected**: A JSON response with your full schema — models, fields, edges, relations.

### Integration test with checkScenario

```typescript
import { checkScenario } from '@autonoma-ai/sdk'
import { prismaAdapter } from '@autonoma-ai/sdk-prisma'

const adapter = prismaAdapter(prisma, { scopeField: 'organizationId' })

const result = await checkScenario(adapter, {
  create: {
    Organization: [{
      name: 'Test Org',
      slug: 'test-org',
      members: [{
        role: 'owner',
        user: [{ name: 'Admin', email: 'admin@test.com' }],
      }],
    }],
  },
})

// result.valid   — true if up + down both succeeded
// result.phase   — 'ok' | 'up' | 'down' (where it failed)
// result.timing  — { upMs, downMs }
// result.errors  — [{ phase, message, fix? }]
```

`checkScenario` runs the full `up` → `down` cycle against a real database. If it fails, `result.errors[0].fix` tells you exactly what to change.

### What to verify

1. **After `up`**: Query the database (read-only) to confirm all expected records exist with correct field values
2. **After `down`**: Query the database to confirm all created records were deleted — no orphans remain
3. **Auth works**: Use the returned cookies/headers to make an authenticated request to your app

## Enable in Production

The endpoint returns 404 in production by default. When you're ready:

```typescript
export const POST = createHandler({
  adapter: prismaAdapter(prisma, { scopeField: 'organizationId' }),
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  allowProduction: true,
  auth: async (user) => { /* ... */ },
})
```

## Connect to Autonoma

Deploy your endpoint and paste `AUTONOMA_SHARED_SECRET` into the Autonoma dashboard when connecting your app. The platform will:

1. Call `discover` to learn your schema
2. Generate scenario data based on your models
3. Send that data in `up` requests before each test
4. Send `down` requests after each test to clean up

## Troubleshooting

| Problem | Cause | Fix |
| --- | --- | --- |
| `INVALID_SIGNATURE` (401) | Shared secret mismatch | Check `AUTONOMA_SHARED_SECRET` matches between your server and the Autonoma dashboard |
| `SAME_SECRETS` (500) | Both secrets are identical | Use two different values from `openssl rand -hex 32` |
| `PRODUCTION_BLOCKED` (404) | Running in production mode | Set `allowProduction: true` or ensure `NODE_ENV` is not `production` |
| `INVALID_REFS_TOKEN` (403) | Signing secret changed between `up` and `down` | Ensure the same `AUTONOMA_SIGNING_SECRET` is used for both |
| `FACTORY_MISSING_PK` | Factory `create` didn't return the primary key | Ensure your factory returns at least `{ id: "..." }` |
| FK violation on `up` | Missing required FK in scenario data | Check that all required relationships are nested correctly in the create tree |
| FK violation on `down` | Circular FK between tables | The SDK handles cycles with deferred updates — if this still fails, check for untracked FKs |
| Parallel tests collide | Same email/name across runs | Use `testRunId` in all unique fields |
