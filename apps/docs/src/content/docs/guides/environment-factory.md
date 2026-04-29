---
title: Environment Factory Guide
description: How to set up the Autonoma Environment Factory in your application using the SDK — a single POST endpoint for creating and destroying isolated test environments.
---

:::note
This guide covers the SDK-based setup for the Environment Factory. For framework-specific examples, see [Examples](/examples/) — covering TypeScript, Python, Elixir, Java, Ruby, Rust, Go, and PHP.
:::

:::tip
For the exact JSON contract of the recipe file that drives this endpoint at runtime, see the [Scenario Recipe Schema reference](/reference/scenario-recipe-schema/).
:::

## The Big Picture

Before Autonoma runs an E2E test, it needs two things:

1. **Data** — a user account, some test records, whatever the test scenario requires
2. **Authentication** — a way to log in as that user (cookies, headers, or credentials)

After the test finishes, everything gets cleaned up so the next test starts fresh.

You set up **one endpoint** that the Autonoma SDK handles for you. It responds to three actions:

| Action       | When it's called               | What happens                                                           |
| ------------ | ------------------------------ | ---------------------------------------------------------------------- |
| **discover** | When Autonoma connects         | Returns the schema derived from your registered factories' input schemas |
| **up**       | Before each test run           | Validates each entity, calls your factory, generates auth credentials  |
| **down**     | After each test run            | Verifies the signed token and calls each factory's `teardown`          |

The SDK orders entities from the create payload's `_alias` / `_ref` graph, validates inputs through each factory's `inputSchema` / `input_model`, signs teardown tokens, and manages the full lifecycle. You configure the adapter, register one factory per model the dashboard can create, and implement an auth callback.

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
  "sdk": { "language": "typescript", "orm": "unknown", "server": "web" },
  "schema": {
    "models": [
      { "name": "Organization", "tableName": "organization", "fields": [{ "name": "id", "type": "string", "isRequired": false, "isId": true, "hasDefault": true }, { "name": "name", "type": "string", "isRequired": true, "isId": false, "hasDefault": false }] },
      { "name": "User", "tableName": "user", "fields": [{ "name": "id", "type": "string", "isRequired": false, "isId": true, "hasDefault": true }, { "name": "email", "type": "string", "isRequired": true, "isId": false, "hasDefault": false }] }
    ],
    "edges": [],
    "relations": [],
    "scopeField": "organizationId"
  }
}
```

The schema contains:
- **models**: every model the dashboard can create — derived directly from each factory's `inputSchema` / `input_model`. Field metadata (name, type, required, id, hasDefault) comes from the schema introspection.
- **edges** / **relations**: emitted as empty arrays. The dashboard reads dependencies from each create payload's `_alias` / `_ref` graph at request time — there is no static FK schema in the discover response anymore.
- **scopeField**: the field name used for test data isolation (e.g., `organizationId`).

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

The `create` field is a flat or nested JSON tree of entities. The SDK:
- Walks the payload to collect every `_alias` declaration and every `_ref` usage.
- Topologically sorts the entities so dependency targets are created before dependents.
- Validates each entity through its factory's `inputSchema` / `input_model` before invoking `create`.
- Replaces every `{"_ref": "alias"}` placeholder with the real id once the aliased entity exists.

The dashboard now sends a flat map keyed by model name with `_alias` / `_ref` describing the dependency graph; nested children are still supported but no longer required.

**Response:**

```json
{
  "version": "0.2.0",
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
  "version": "0.2.0",
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

- **UP can only CREATE** — it invokes the factories you registered, which call your existing services / repositories. It cannot UPDATE, DELETE, DROP, TRUNCATE, or run raw SQL outside whatever your factory body runs.
- **DOWN can only DELETE what UP created** — verified by the signed refs token. It calls each factory's `teardown` for the records listed in the token, in reverse topological order.
- **No raw SQL from the SDK** — the SDK never runs SQL itself. It calls your factories, which invoke whatever services / repositories your app already has.

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
| Python | `pyproject.toml` / `requirements.txt` | [`autonoma-ai`](https://pypi.org/project/autonoma-ai/) |
| Go | `go.mod` | `github.com/autonoma-ai/autonoma-sdk-go` |
| Rust | `Cargo.toml` | `autonoma` crate |
| Java | `pom.xml` / `build.gradle` | `ai.autonoma:autonoma-sdk` |
| Ruby | `Gemfile` / `*.gemspec` | `autonoma` gem |
| PHP | `composer.json` | `autonoma/sdk` |
| Elixir | `mix.exs` | `autonoma` hex package |

If your backend is in a language without a matching SDK, open an issue — do not spin up a polyglot sidecar. Running a Python `FastAPI` next to a NestJS app so you can use the Python SDK will silently drift from your production code (auth flows, hashing, hooks, triggers) and create maintenance headaches.

Backend directory detection: scan for the manifest file above. Real projects use many conventions — `backend/`, `server/`, `api/`, `apps/api/`, `services/core/`, `core-app-backend/`, etc. — so don't assume the directory is named `backend/`.

### 1. Install

The SDK is **factory-driven**: you register one factory per model and the SDK derives the discover schema from each factory's input schema (Zod in TypeScript, Pydantic in Python). There is no SQL introspection, no ORM executor, and no SQL fallback. Pick the packages that match your stack:

**Next.js App Router**:
```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/server-web zod
```

**Express**:
```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/server-express zod
```

**Hono**:
```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/server-hono zod
```

**Bun / Deno** (Web standard `Request`/`Response`):
```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/server-web zod
```

**Node.js http**:
```bash
pnpm add @autonoma-ai/sdk @autonoma-ai/server-node zod
```

**Python** ([PyPI](https://pypi.org/project/autonoma-ai/)):
```bash
pip install autonoma-ai
```

The `autonoma-ai` package includes the core SDK plus framework adapters (`autonoma_fastapi`, `autonoma_flask`, `autonoma_django`). Pydantic is a hard dependency.

#### Package reference

| Your Framework | Package | Handler export |
|----------------|---------|----------------|
| Next.js App Router, Bun, Deno (Web standard `Request`/`Response`) | `@autonoma-ai/server-web` | `createHandler` |
| Hono | `@autonoma-ai/server-hono` | `createHonoHandler` |
| Express, Fastify | `@autonoma-ai/server-express` | `createExpressHandler` |
| Node.js `http` | `@autonoma-ai/server-node` | `createNodeHandler` |
| FastAPI (Python) | `autonoma_fastapi` | `create_fastapi_handler` |
| Flask (Python) | `autonoma_flask` | `create_flask_handler` |
| Django (Python) | `autonoma_django` | `create_django_handler` |

### 2. Find your scope field

Pick the field most of your models use to reference the root tenant entity — usually `organizationId`, `orgId`, `tenantId`, or `workspaceId`. The SDK does not introspect FKs to find this; it just declares the field in the discover response so the dashboard knows how to scope test data. Your factories own the actual writes — including any tenant-scoped FK columns.

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

export const POST = createHandler({
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  factories: { /* see section 6 */ },
  auth: async (user) => {
    // Create a real session for this user — see section 5
    const session = await createSession(user!.id as string)
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

app.post('/api/autonoma', createExpressHandler({
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  factories: { /* see section 6 */ },
  auth: async (user) => {
    const token = jwt.sign({ sub: user!.id }, process.env.JWT_SECRET!)
    return { headers: { Authorization: `Bearer ${token}` } }
  },
}))
```

#### Hono

```typescript
// src/routes/autonoma.ts
import { createHonoHandler } from '@autonoma-ai/server-hono'

app.post('/api/autonoma', createHonoHandler({
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  factories: { /* see section 6 */ },
  auth: async (user) => {
    const token = await createToken(user!.id as string)
    return { headers: { Authorization: `Bearer ${token}` } }
  },
}))
```

#### FastAPI (Python)

```python
# autonoma_handler.py
import os
from autonoma.types import HandlerConfig
from autonoma_fastapi import create_fastapi_handler

config = HandlerConfig(
    scope_field='organization_id',
    shared_secret=os.environ['AUTONOMA_SHARED_SECRET'],
    signing_secret=os.environ['AUTONOMA_SIGNING_SECRET'],
    factories={ ...  # see section 6 },
    auth=lambda user, ctx: {'headers': {'Authorization': f'Bearer {issue_token(user)}'}},
)

router = create_fastapi_handler(config)
app.include_router(router, prefix='/api/autonoma')
```

### 5. Implement the auth callback

The `auth` callback receives the first `User` record created during `up`. It must return real, working credentials that the test runner can use to authenticate with your app.

**This is critical.** If the auth callback returns fake or expired tokens, every test will fail at the login step.

#### What the callback receives

```typescript
auth: async (user, context) => {
  // user: the first User record from refs, or `null` if no User model exists.
  //   Always check for null — not every scenario creates a User.
  //   Shape: { id: 'clxyz...', name: 'Admin', email: 'admin-abc123@test.com', ... }
  // context:
  //   - scopeValue: the detected scope value (e.g. organization id) or testRunId fallback
  //   - refs: all created records keyed by model name, for looking up related data
}
```

#### What the callback must return

```typescript
interface AuthResult {
  cookies?: Array<{                   // Session cookies
    name: string
    value: string
    httpOnly?: boolean
    sameSite?: 'strict' | 'lax' | 'none'
    path?: string
    domain?: string
    secure?: boolean
    maxAge?: number
  }>
  headers?: Record<string, string>    // Custom auth headers (use for bearer tokens: `Authorization: Bearer …`)
  credentials?: Record<string, string>  // Arbitrary key/value pairs for manual login flows (e.g. { email, password })
}
```

There is no top-level `token` field. To return a bearer token, put it on `headers` as `Authorization: Bearer …`. To return email/password for a native login flow, put them on `credentials`.

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
    { sub: user!.id, email: user!.email },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  )
  return { headers: { Authorization: `Bearer ${token}` } }
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

Register a **factory** for every model the dashboard can create. There is no SQL fallback — every model the SDK writes goes through your factory. The factory's `inputSchema` (Zod) / `input_model` (Pydantic) drives both the discover schema and validation of the create payload.

**Why factory-by-default?** If you already have `ProjectService.create()` that today just wraps `prisma.project.create()`, wire it up anyway. The day you add an audit log, a Stripe sync, or a cache write to that function, your tests keep working — zero rewiring. The factory always runs the same code path the rest of your app does.

For models without a dedicated create function, register a factory whose body is a thin repository call. The Step 2 audit classifies models with `independently_created: true` (call the audit's identified function) vs `independently_created: false` (a thin repository call is fine).

```typescript
import { z } from 'zod'
import { defineFactory } from '@autonoma-ai/sdk'

const OrganizationInput = z.object({ name: z.string(), slug: z.string() })
const OrganizationRef = z.object({ id: z.string(), name: z.string(), slug: z.string() })
const UserInput = z.object({ email: z.string(), name: z.string() })

const handler = createExpressHandler({
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  factories: {
    Organization: defineFactory({
      inputSchema: OrganizationInput,
      // Optional: validates the record on teardown and types `record` for free.
      refSchema: OrganizationRef,
      // `data` is typed `{ name: string; slug: string }` — no z.infer<...> needed.
      create: async (data) => organizationService.create({ name: data.name, slug: data.slug }),
      // `record` is typed `{ id: string; name: string; slug: string }` from refSchema.
      teardown: async (record) => organizationService.delete(record.id),
    }),
    User: defineFactory({
      inputSchema: UserInput,
      create: async (data) =>
        userService.create({
          email: data.email,
          name: data.name,
          password: 'test-password-123', // known password for auth
        }),
      // No teardown: this model is left alone on `down`.
    }),
  },
  auth: async (user) => { /* ... */ },
})
```

The `defineFactory` generics are inferred from the schemas you pass:
- `data` inside `create` is typed as `z.infer<typeof inputSchema>`.
- When `refSchema` is set, `record` inside `teardown` is typed as `z.infer<typeof refSchema>`, and `create`'s return type is constrained to that shape too.
- When `refSchema` is omitted, `record` widens to `Record<string, unknown> & { id: string | number }` so legacy factories keep compiling without it.

#### How factories work

1. The SDK reads the create payload's `_alias` / `_ref` graph and topologically sorts entities — no FK introspection, no schema needed.
2. For each model in order, the SDK validates the entity through `inputSchema.safeParse(...)` (Zod) / `input_model.model_validate(...)` (Pydantic) and calls your `create` with the typed value.
3. **Factory receives pre-resolved fields** — `_ref` placeholders are already replaced with the real id of the referenced entity. The factory never sees `{"_ref": "..."}` or `__temp_*` values.
4. **Factory must return at least the primary key** (e.g., `{ id: "..." }`). All returned fields are stored in refs and available to subsequent factories via `ctx.refs`.
5. On teardown: if a factory defines `teardown`, it's called per record in reverse topological order; otherwise that model is left alone.

#### When to register a factory

Always. The SDK writes through factories only — every model the dashboard can create needs one. The Step 2 entity audit classifies how the factory body should look:

| Audit value | Factory body |
| --- | --- |
| `independently_created: true` (a `create`/`insert`/`register` function exists in a service or repository) | Call that function from `create`. |
| `independently_created: true` and additionally hashes passwords, generates slugs, syncs to Stripe, etc. | Call the function — your factory inherits the logic for free. |
| `independently_created: false` (only inline ORM calls scattered across route handlers, or no create path at all) | Make the same ORM call directly from `create`. |
| Model is never created at all (seed-only lookup table) | Either omit it from your scenarios, or write a factory that re-creates the seed row. |

See [Dependents, cascades, and teardown](#dependents-cascades-and-teardown) below for how transitively-created rows come and go.

#### Dependents, cascades, and teardown

A root can mint dependent rows inline — e.g. `<Root>Service.create` may insert a root row plus a default child, a grandchild, and an onboarding row, all in one transaction. Step 2 records each dependent with a `created_by: [{owner, via, why}]` pointing back at the owner. The SDK does not automatically know about those rows; you have to tell it how to tear them down. Four options, in preference order:

1. **Schema cascade** — the FK chain from every dependent back to the root is `onDelete: Cascade` (Prisma) / `ON DELETE CASCADE` (raw SQL). Deleting the root row is enough; the DB handles the rest. Nothing to configure on the factory. This is the easiest case and usually the intent when the production code mints everything in one transaction.
2. **Call the app's delete function** — if your codebase already has a delete method that tears down the same subtree (e.g. a `<Root>Service.delete` that removes the root and every dependent it minted), register `teardown` on the root's factory to call it:

   ```typescript
   <Root>: defineFactory({
     inputSchema: <Root>Input,
     create: async (data) => <Root>Service.create(data),
     teardown: async (record) => <Root>Service.delete(record.id as string),
   }),
   ```

3. **Forward dependent IDs that the production `create` already returns** — if the production `create` function returns the dependent IDs in its result (e.g. `{ root, child, grandchild }`), surface those IDs from the factory so they land in refs, and write a `teardown` that deletes them in reverse FK order using your app's existing DB client:

   ```typescript
   import { db } from '@/db'

   <Root>: defineFactory({
     inputSchema: <Root>Input,
     create: async (data) => {
       const { root, child, grandchild } = await <Root>Service.create(data)
       return { id: root.id, childId: child.id, grandchildId: grandchild.id }
     },
     teardown: async (record) => {
       await db.<grandchild>.delete({ where: { id: record.grandchildId } })
       await db.<child>.delete({ where: { id: record.childId } })
       await db.<root>.delete({ where: { id: record.id } })
     },
   }),
   ```

4. **None of the above — STOP.** Do NOT modify your production service to return more IDs than it already does just to satisfy the test harness. Adding test-only return values to production code inverts the relationship we want (tests adapt to production, not the other way around). Instead, report the gap: add a cascade to the schema, add a delete function to the service, or accept orphans between runs (acceptable when the test database is reset periodically).

Pure dependents (`independently_created: false`) typically still get a factory — registered as a thin repository call — unless they are minted transitively by the parent's `create`. If they are, omit them from the create payload and let the parent's `teardown` clean them up.

#### Factory context

Both `create` and `teardown` receive a context object. There is no SDK-managed DB client — your factory imports the same client/repository singletons your app's services use:

```typescript
interface FactoryContext {
  refs: Record<string, Record<string, unknown>[]>  // all records created so far
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
import { checkScenario, defineFactory } from '@autonoma-ai/sdk'
import { z } from 'zod'

const factories = {
  Organization: defineFactory({
    inputSchema: z.object({ name: z.string(), slug: z.string() }),
    refSchema: z.object({ id: z.string() }),
    // `data` typed { name: string; slug: string }; `record` typed { id: string }
    create: async (data) => organizationService.create(data),
    teardown: async (record) => organizationService.delete(record.id),
  }),
  User: defineFactory({
    inputSchema: z.object({ name: z.string(), email: z.string(), organizationId: z.string() }),
    create: async (data) => userService.create(data),
  }),
}

const result = await checkScenario(
  factories,
  {
    create: {
      Organization: [{ _alias: 'org', name: 'Test Org', slug: 'test-org' }],
      User: [{ name: 'Admin', email: 'admin@test.com', organizationId: { _ref: 'org' } }],
    },
  },
  { scopeField: 'organizationId' },
)

// result.valid   — true if up + down both succeeded
// result.phase   — 'ok' | 'up' | 'down' (where it failed)
// result.timing  — { upMs, downMs }
// result.errors  — [{ phase, message, fix? }]
```

`checkScenario` runs the full `up` → `down` cycle through your factories — same code path the dashboard would hit.

### What to verify

1. **After `up`**: Query the database (read-only) to confirm all expected records exist with correct field values
2. **After `down`**: Query the database to confirm all created records were deleted — no orphans remain
3. **Auth works**: Use the returned cookies/headers to make an authenticated request to your app

## Enable in Production

The endpoint returns 404 in production by default. When you're ready:

```typescript
export const POST = createHandler({
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  factories: { /* ... */ },
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
