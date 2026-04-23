---
title: "TypeScript"
description: "Autonoma Environment Factory examples with Express + Prisma and Next.js + Drizzle."
---

## Express + Prisma

Uses `createExpressHandler` from `@autonoma-ai/server-express` with `prismaExecutor` from `@autonoma-ai/sdk-prisma`. Factories are registered for every model that has a dedicated create function in the codebase (Organization, User). Models without one (Project, Task — only inline ORM calls) fall back to raw SQL automatically.

```typescript
// src/index.ts
import express from 'express'
import { PrismaClient } from '@prisma/client'
import { prismaExecutor } from '@autonoma-ai/sdk-prisma'
import { createExpressHandler } from '@autonoma-ai/server-express'
import { defineFactory } from '@autonoma-ai/sdk'
import { OrganizationRepository } from './repositories/organization'
import { UserRepository } from './repositories/user'

const prisma = new PrismaClient()
const organizationRepo = new OrganizationRepository(prisma)
const userRepo = new UserRepository(prisma)

const app = express()
app.use(express.json())

app.post(
  '/api/autonoma',
  createExpressHandler({
    // Connects the SDK to your database through Prisma
    executor: prismaExecutor(prisma),
    // The column that scopes all models to a tenant — used to isolate test data
    scopeField: 'organizationId',
    // Shared with Autonoma — verifies incoming requests via HMAC-SHA256
    sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
    // Private to your server — signs the refs token so teardown only deletes what was created
    signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,

    // Factory per model with a dedicated create function in your codebase.
    // Models without a factory (Project, Task) fall back to raw SQL.
    factories: {
      // Organization: slug generation, default settings, external services
      Organization: defineFactory({
        create: async (data) => organizationRepo.create({ name: data.name as string }),
        teardown: async (record) => organizationRepo.delete(record.id as string),
      }),
      // User: password hashing, email normalization
      User: defineFactory({
        create: async (data) => userRepo.create({
          email: data.email as string,
          name: data.name as string,
          organizationId: data.organizationId as string,
        }),
      }),
    },

    // Called after `up` — returns credentials so Autonoma can make authenticated requests
    auth: async (user) => ({ headers: { Authorization: `Bearer test-token` } }),
  }),
)
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/express-prisma)

---

## Next.js + Drizzle

Uses `createHandler` from `@autonoma-ai/server-web` with `drizzleExecutor` from `@autonoma-ai/sdk-drizzle`. The Web standard `Request`/`Response` API also works with Hono, Deno, and Bun.

:::note
With Drizzle, factory keys use snake_case table names (`organizations`, `users`) instead of PascalCase model names.
:::

```typescript
// src/app/api/autonoma/route.ts
import { createHandler } from '@autonoma-ai/server-web'
import { drizzleExecutor } from '@autonoma-ai/sdk-drizzle'
import { defineFactory } from '@autonoma-ai/sdk'
import { db } from '@/db'
import { OrganizationRepository } from '@/repositories/organization'
import { UserRepository } from '@/repositories/user'

const organizationRepo = new OrganizationRepository()
const userRepo = new UserRepository()

export const POST = createHandler({
  // Connects the SDK to your database through Drizzle
  executor: drizzleExecutor(db),
  // The column that scopes all models to a tenant — used to isolate test data
  scopeField: 'organizationId',
  // Shared with Autonoma — verifies incoming requests via HMAC-SHA256
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  // Private to your server — signs the refs token so teardown only deletes what was created
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,

  // Factory per model with a dedicated create function in your codebase.
  // Models without a factory fall back to raw SQL.
  factories: {
    organizations: defineFactory({
      create: async (data) => organizationRepo.create({ name: data.name as string }),
      teardown: async (record) => organizationRepo.delete(record.id as string),
    }),
    users: defineFactory({
      create: async (data) => userRepo.create({
        email: data.email as string,
        name: data.name as string,
        organizationId: data.organization_id as string,
      }),
    }),
  },

  // Called after `up` — returns credentials so Autonoma can make authenticated requests
  auth: async (user) => ({ headers: { Authorization: `Bearer test-token` } }),
})
```

[Full source code on GitHub](https://github.com/Autonoma-AI/sdk/tree/main/examples/typescript/nextjs-drizzle)
