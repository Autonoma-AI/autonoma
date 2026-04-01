---
title: Common Workflows
description: Step-by-step guides for common development tasks - adding routes, pages, commands, models, tests, and more.
---

This page covers the most common development tasks you will perform in the Autonoma monorepo. Each workflow is a step-by-step guide with file paths and code patterns.

## Adding a New tRPC Route

Types flow through tRPC from API to frontend. Never manually define API response types on the frontend.

**1. Define Zod schemas** in `packages/types/src/schemas/`:

```ts
// packages/types/src/schemas/my-feature.ts
import z from "zod";

export const myFeatureInput = z.object({
  name: z.string(),
  organizationId: z.string(),
});

export const myFeatureOutput = z.object({
  id: z.string(),
  createdAt: z.date(),
});
```

**2. Create a controller** in `apps/api/src/controllers/<routerName>/<procedureName>.ts`. Controllers hold all business logic:

```ts
// apps/api/src/controllers/myFeature/create.ts
import type { PrismaClient } from "@autonoma/db";
import type { z } from "zod";
import type { myFeatureInput } from "@autonoma/types";

export async function createMyFeature(
  db: PrismaClient,
  input: z.infer<typeof myFeatureInput>,
) {
  return db.myFeature.create({
    data: { name: input.name, organizationId: input.organizationId },
  });
}
```

**3. Create or update the router** in `apps/api/src/routers/`. Routers are thin wiring - they delegate to controllers:

```ts
// apps/api/src/routers/my-feature.ts
import { router, protectedProcedure } from "../trpc";
import { myFeatureInput } from "@autonoma/types";
import { createMyFeature } from "../controllers/myFeature/create";

export const myFeatureRouter = router({
  create: protectedProcedure
    .input(myFeatureInput)
    .mutation(async ({ ctx, input }) => {
      return createMyFeature(ctx.db, input);
    }),
});
```

**4. Add to `appRouter`** in `apps/api/src/router.ts` (if this is a new router):

```ts
export const appRouter = router({
  // ...existing routers
  myFeature: myFeatureRouter,
});
```

**5. Use on the frontend.** For queries, use `useSuspenseQuery` with `queryOptions`:

```ts
const { data } = useSuspenseQuery(
  trpc.myFeature.list.queryOptions({ organizationId }),
);
```

For mutations, use `useAPIMutation` with `mutationOptions`:

```ts
const createMutation = useAPIMutation(
  trpc.myFeature.create.mutationOptions(),
);
```

## Adding a New Page

TanStack Router with file-based routing makes this straightforward.

**1. Create a route file** in `apps/ui/src/routes/`:

```ts
// apps/ui/src/routes/my-feature.tsx
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/my-feature")({
  component: MyFeaturePage,
});

function MyFeaturePage() {
  return <div>My Feature</div>;
}
```

**2. That's it.** The TanStack Router plugin auto-generates the route tree. The page is immediately accessible at `/my-feature`.

For pages that need data, add a `loader`:

```ts
export const Route = createFileRoute("/my-feature")({
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(
      trpc.myFeature.list.queryOptions(),
    );
  },
  component: MyFeaturePage,
});
```

## Database Schema Changes

**1. Edit the schema** at `packages/db/prisma/schema.prisma`.

**2. Create a migration:**

```bash
pnpm db:migrate
```

This generates a migration file and applies it to your local database.

**3. Regenerate the Prisma client:**

```bash
pnpm db:generate
```

**4. Run typecheck** to catch any type errors from the schema change:

```bash
pnpm typecheck
```

If multiple queries in a service method need to be consistent (read-then-write, or writes to multiple tables), wrap them in a Prisma `$transaction`:

```ts
return await this.db.$transaction(async (tx) => {
  const existing = await tx.myTable.findFirst({ where: { id } });
  if (existing == null) throw new Error("Not found");
  return tx.myTable.update({ where: { id }, data: { ... } });
});
```

## Adding a New Command to the Execution Agent

See the [Execution Agent](/architecture/execution-agent/#adding-a-new-command) page for a detailed walkthrough. The short version:

**1. Define the spec** with a `CommandSpec` interface and Zod schema in `packages/engine/src/commands/commands/<name>/<name>.def.ts`.

**2. Implement the command** by extending `Command<TSpec, TContext>` in `packages/engine/src/commands/commands/<name>/<name>.command.ts`.

**3. Create the tool wrapper** by extending `CommandTool<TSpec, TContext>` in `packages/engine/src/execution-agent/agent/tools/commands/<name>.tool.ts`.

**4. Add the spec** to the union type in `packages/engine/src/commands/command-defs.ts`.

**5. Register the tool** in the `ExecutionAgentFactory` subclass for the relevant platform(s).

**6. Write tests** in `packages/engine/src/commands/commands/<name>/<name>.test.ts`. Use the test utilities in `packages/engine/src/commands/test-utils/` for fake drivers and model registries.

## Adding a New AI Model

See the [AI Package](/architecture/ai-package/#adding-a-new-model) page for full details. The short version:

**1. Add the model entry** to `MODEL_ENTRIES` in `packages/ai/src/registry/model-entries.ts`:

```ts
MY_MODEL: {
  createModel: () => googleProvider.getModel("my-model-id"),
  pricing: simpleCostFunction({
    inputCostPerM: 0.5,
    outputCostPerM: 1.5,
  }),
},
```

**2. Add a provider** in `packages/ai/src/registry/providers.ts` if the model uses a new provider. Add the API key to `packages/ai/src/env.ts` using `createEnv`.

**3. Use it** via `registry.getModel({ model: "MY_MODEL", tag: "my-use-case" })`.

## Running and Writing Tests

Vitest is used everywhere. Every package has it installed.

### Running Tests

```bash
# Run all tests across the monorepo
pnpm test

# Run tests for a specific package
pnpm --filter @autonoma/engine test

# Run a specific test file
pnpm --filter @autonoma/ai test -- src/visual/assert-checker.test.ts

# Run in watch mode
pnpm --filter @autonoma/engine test -- --watch
```

### Writing Tests

**Prefer integration tests over unit tests.** Only test what provides value - don't test trivial getters.

Test files go in `test/` directories or alongside source files as `*.test.ts`.

**Never mock the database.** For tests that need a database, use Testcontainers with a real PostgreSQL container via the `@autonoma/integration-test` package:

```ts
import { integrationTestSuite } from "@autonoma/integration-test";

integrationTestSuite("MyService", ({ getDb }) => {
  it("creates a record", async () => {
    const db = getDb();
    const result = await myService.create(db, { name: "test" });
    expect(result.name).toBe("test");
  });
});
```

For command tests, use the fake drivers in `packages/engine/src/commands/test-utils/`:

```ts
import { FakeScreenDriver } from "../test-utils/fake-screen.driver";
import { FakeMouseDriver } from "../test-utils/fake-mouse.driver";
```

## Working with the UI Component Library

All frontend components come from `@autonoma/blacklight`, built on Radix UI + Tailwind CSS v4 + CVA.

### Using Components

```tsx
import { Button, Card, Input, cn } from "@autonoma/blacklight";

function MyComponent() {
  return (
    <Card className={cn("p-4")}>
      <Input placeholder="Enter name" />
      <Button variant="default" size="sm">
        Submit
      </Button>
    </Card>
  );
}
```

### Icons

Use Lucide React for all icons:

```tsx
import { Plus, Settings } from "lucide-react";

<Button>
  <Plus className="size-4" />
  Add item
</Button>
```

### Custom Variants

Use CVA (class-variance-authority) for component variants:

```tsx
import { cva } from "class-variance-authority";

const badgeVariants = cva("rounded-full px-2 py-0.5 text-xs font-medium", {
  variants: {
    status: {
      active: "bg-green-100 text-green-800",
      inactive: "bg-gray-100 text-gray-800",
    },
  },
});
```

## Adding Environment Variables

Never read `process.env` directly. Always use `createEnv` from `@t3-oss/env-core`.

**1. Define the variable** in a dedicated `env.ts` file for the package or app:

```ts
// packages/my-package/src/env.ts
import { createEnv } from "@t3-oss/env-core";
import z from "zod";

export const env = createEnv({
  server: {
    MY_API_KEY: z.string().min(1),
    MY_TIMEOUT: z.coerce.number().default(5000),
  },
  runtimeEnv: process.env,
});
```

**2. Use the validated env** in your code:

```ts
import { env } from "./env";

const client = new MyClient({ apiKey: env.MY_API_KEY });
```

**3. For library code**, prefer passing values as function parameters rather than reading env directly. This keeps the library testable and reusable:

```ts
// Good - library accepts config
export class MyService {
  constructor(private readonly apiKey: string) {}
}

// App wires it up with env
const service = new MyService(env.MY_API_KEY);
```

**4. Check the catalog** in `pnpm-workspace.yaml` before adding `@t3-oss/env-core` as a dependency. If it is already in the catalog, use `"@t3-oss/env-core": "catalog:"` in your `package.json`.

## Adding Dependencies

Before adding any dependency, check `pnpm-workspace.yaml` for the catalog:

```bash
# Check if the package exists in the catalog
grep "my-package" pnpm-workspace.yaml
```

If the package is in the catalog, use `catalog:` as the version:

```json
{
  "dependencies": {
    "zod": "catalog:"
  }
}
```

If it is not in the catalog but will be shared across multiple packages, consider adding it there first.

Then install:

```bash
pnpm install
```

## Building and Type Checking

```bash
# Build everything (Turborepo handles dependency order)
pnpm build

# Type check all packages
pnpm typecheck

# Lint all packages
pnpm lint

# Run dev servers (web on 3000, API on 4000)
pnpm dev
```

All packages are ESM-only. Never use `.js` extensions in imports - TypeScript resolves modules automatically.
