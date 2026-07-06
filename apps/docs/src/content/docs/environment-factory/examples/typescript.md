---
title: "TypeScript"
description: "Autonoma Environment Factory examples with Express, Hono, and Next.js."
---

The TypeScript SDK is **factory-driven**: you register one factory per model and the SDK derives the discover schema from each factory's Zod `inputSchema`. There is no database introspection, no ORM executor, and no SQL fallback - your factories own creation, the SDK owns the protocol.

`zod` is a peer dependency: `npm install zod` (any v3.23+ or v4 release works).

## Express

Uses `createExpressHandler` from `@autonoma-ai/server-express`. The factories use whatever Prisma / Drizzle / pg client your app already has - the SDK does not need a connection.

```typescript
// src/index.ts
import express from 'express'
import { z } from 'zod'
import { defineFactory } from '@autonoma-ai/sdk'
import { createExpressHandler } from '@autonoma-ai/server-express'
import { PrismaClient } from '@prisma/client'

import { OrganizationRepository } from './repositories/organization'
import { UserRepository } from './repositories/user'

const prisma = new PrismaClient()
const organizationRepo = new OrganizationRepository(prisma)
const userRepo = new UserRepository(prisma)

const OrganizationInput = z.object({ name: z.string() })
const UserInput = z.object({
  email: z.string(),
  name: z.string(),
  organizationId: z.string(),
})

const app = express()
app.use(express.json())

app.post(
  '/api/autonoma',
  createExpressHandler({
    // The column that scopes all models to a tenant
    scopeField: 'organizationId',
    // Shared with Autonoma - verifies incoming requests via HMAC-SHA256
    sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
    // Private to your server - signs the refs token so teardown only deletes what was created
    signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,

    // Every model the dashboard can create needs a factory.
    // `defineFactory` infers `data`'s type from `inputSchema` - no z.infer<...> needed.
    factories: {
      Organization: defineFactory({
        inputSchema: OrganizationInput,
        create: async (data) => organizationRepo.create({ name: data.name }),
        teardown: async (record) =>
          organizationRepo.delete(record.id as string),
      }),
      User: defineFactory({
        inputSchema: UserInput,
        create: async (data) =>
          userRepo.create({
            email: data.email,
            name: data.name,
            organizationId: data.organizationId,
          }),
      }),
    },

    // Called after `up` - returns credentials so Autonoma can make authenticated requests
    auth: async (user) => ({ headers: { Authorization: 'Bearer test-token' } }),
  }),
)
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/express)

---

## Next.js (App Router)

`createHandler` from `@autonoma-ai/server-web` works with any Web-standard runtime: Next.js App Router, Hono, Bun, Deno.

```typescript
// src/app/api/autonoma/route.ts
import { z } from 'zod'
import { defineFactory } from '@autonoma-ai/sdk'
import { createHandler } from '@autonoma-ai/server-web'

import { db } from '@/db'
import { OrganizationRepository } from '@/repositories/organization'
import { UserRepository } from '@/repositories/user'

const organizationRepo = new OrganizationRepository(db)
const userRepo = new UserRepository(db)

const OrganizationInput = z.object({ name: z.string() })
const UserInput = z.object({
  email: z.string(),
  name: z.string(),
  organizationId: z.string(),
})

export const POST = createHandler({
  scopeField: 'organizationId',
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,

  factories: {
    Organization: defineFactory({
      inputSchema: OrganizationInput,
      create: async (data) => organizationRepo.create({ name: data.name }),
      teardown: async (record) =>
        organizationRepo.delete(record.id as string),
    }),
    User: defineFactory({
      inputSchema: UserInput,
      create: async (data) =>
        userRepo.create({
          email: data.email,
          name: data.name,
          organizationId: data.organizationId,
        }),
    }),
  },

  auth: async () => ({ headers: { Authorization: 'Bearer test-token' } }),
})
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/nextjs)

---

## Hono

Same factories, the `createHonoHandler` adapter unwraps a Hono `Context` into the Web-standard request the SDK expects.

```typescript
import { Hono } from 'hono'
import { createHonoHandler } from '@autonoma-ai/server-hono'

const app = new Hono()
app.post('/api/autonoma', createHonoHandler({ /* same config as above */ }))
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/hono)

---

## What `inputSchema` does

The Zod schema you pass as `inputSchema`:

1. **Drives discover** - the SDK walks the schema's shape to describe the model to the dashboard (field names, types, required/optional, defaults). No database introspection runs.
2. **Validates the create payload** - before invoking your `create` function, the SDK calls `inputSchema.safeParse(payload)` and passes the parsed value in. Validation failures bubble up as a 500 with the field path the dashboard can show inline.
3. **Drives types** - `defineFactory` is generic over the schemas you pass. `data` inside `create` is automatically typed as `z.infer<typeof inputSchema>` and `record` inside `teardown` is automatically typed as `z.infer<typeof refSchema>` when you set one. No `z.infer<...>` annotations at the call site.
4. **Lets you accept extras** - recipes can carry display-only metadata (e.g. `_alias`) without failing validation; Zod ignores keys that aren't part of your schema by default.

### Validated teardown with `refSchema`

Adding a `refSchema` lets `teardown` work against a typed record (validated through Zod first). When `refSchema` is set, `create`'s return type is constrained to its input shape - the same record flows from `create` → `down` token → `teardown` with no manual casts.

```typescript
const ProjectInput = z.object({ name: z.string(), organizationId: z.string() })
const ProjectRef = z.object({ id: z.string(), name: z.string() })

defineFactory({
  inputSchema: ProjectInput,
  refSchema: ProjectRef,
  // `data` typed as { name: string; organizationId: string }
  create: async (data) => projectService.create(data),
  // `record` typed as { id: string; name: string }
  teardown: async (record) => projectService.delete(record.id),
})
```

Without `refSchema`, `create`'s return type widens to `Record<string, unknown> & { id: string | number }` and `record` in `teardown` matches that shape - the existing factories above keep compiling.
