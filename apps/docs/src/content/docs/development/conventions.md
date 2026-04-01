---
title: Code Conventions
description: The rules of the Autonoma AI codebase - TypeScript patterns, error handling, logging, testing, and style guidelines.
---

## ESM-only

Every `package.json` has `"type": "module"`. No CommonJS anywhere in the codebase.

**Never use `.js` extensions in imports.** TypeScript and the bundler resolve modules automatically.

```ts
// Good
import { foo } from "./foo";
import { bar } from "@autonoma/types";

// Bad
import { foo } from "./foo.js";
```

## TypeScript strictness

All strict flags are enabled. Every package extends `tsconfig.base.json`, which includes:

- `strict: true` (enables all strict checks)
- `noUncheckedIndexedAccess` - array and object index access returns `T | undefined`
- `exactOptionalPropertyTypes` - optional properties can't be assigned `undefined` explicitly unless typed that way
- `verbatimModuleSyntax` - enforces explicit `type` imports

In practice, this means:

- You must check array access results before using them
- You must narrow types before passing them to functions that expect non-nullable values
- You must use `import type { ... }` for type-only imports

## Classes vs functions

**Needs state or dependencies?** Use a class with constructor injection.

**Pure logic with no state?** Use a function file.

In practice, almost everything is a class because most logic needs a logger, a database client, or some other dependency.

## Dependency injection

Plain constructor injection. No DI framework, no decorators.

```ts
class StepExecutor {
  private readonly logger: Logger;

  constructor(
    private readonly engine: Engine,
    private readonly db: PrismaClient,
  ) {
    this.logger = logger.child({ name: this.constructor.name });
  }
}
```

You can read any class constructor and immediately see all its dependencies. No magic, no hidden state.

## One export per file

A file exports exactly one thing - a class, a function, or a type. The exported item tells the story top-to-bottom. Private helpers follow in call order.

This keeps files focused and makes imports predictable.

### Custom error hierarchy

```
AutonomaError (base)
  TestError          - test execution failures
  DriverError        - Appium/Playwright driver failures
  PreconditionError  - setup/precondition failures
  VerificationError  - assertion failures
  ThirdPartyError    - external service failures
```

## Prefer undefined over null

Always use `undefined` as the absence-of-value sentinel. Use optional properties (`?`) instead of `| null` types. Never initialize to `null`.

```ts
// Good
private timeout?: number

// Bad
private timeout: number | null = null
```

This applies everywhere: class properties, function parameters, return types, object shapes.

## Nullish checks

Always `??`, never `||`. Always `!= null` / `== null`, never truthy/falsy checks.

```ts
// Good
const timeout = config.timeout ?? 3000;
if (element != null) { /* ... */ }

// Bad - truthy/falsy has unexpected behavior with 0, "", false
const timeout = config.timeout || 3000;  // 0 becomes 3000!
if (element) { /* ... */ }
```

The `!= null` check covers both `null` and `undefined`, which is exactly what you want.

## Early returns

Always prefer early returns to reduce nesting. If a function has deeply nested `if` blocks, extract the inner logic into a separate function with guard clauses.

```ts
// Good
function processOrder(order: Order): Result {
  if (order.status === "cancelled") throw new OrderCancelledError();
  if (order.items.length === 0) throw new EmptyOrderError();

  return calculateTotal(order);
}

// Bad - deeply nested
function processOrder(order: Order): Result {
  if (order.status !== "cancelled") {
    if (order.items.length > 0) {
      return calculateTotal(order);
    }
  }
  // ...
}
```

## No complex destructuring or spread

If constructing an object requires multiple `...` spreads or ternary-based spreads, build the object explicitly instead.

```ts
// Good
const permissions = isAdmin ? allPermissions : readOnly;
return {
  name: baseConfig.name,
  timeout: baseConfig.timeout,
  permissions,
  retries: overrides.retries ?? baseConfig.retries,
};

// Bad
return {
  ...baseConfig,
  ...((isAdmin) ? { permissions: allPermissions } : { permissions: readOnly }),
  ...overrides,
};
```

## Extract complex conditions

If a condition isn't immediately obvious, extract it into a descriptively named variable.

```ts
// Good
const isTrialExpired = subscription.status === "trial" && subscription.endsAt < now;
const hasNoPaymentMethod = user.paymentMethods.length === 0;
if (isTrialExpired && hasNoPaymentMethod) { /* ... */ }

// Bad - what does this check?
if (subscription.status === "trial" && subscription.endsAt < now && user.paymentMethods.length === 0) { /* ... */ }
```

## Avoid let + conditional assignment

Instead of using `let` and assigning in `if/else` blocks, extract a function with early returns.

## Logging with Sentry

Every class and every function file must have logging. When in doubt, add a log. Overlogging is always better than underlogging.

### What to log

- Service startup and configuration
- Incoming requests and their resolution (success/failure)
- External API calls (start, success, failure)
- State transitions (agent steps, job status changes)
- Resource acquisition/release (device locks, browser sessions)
- Every public method entry with relevant parameters
- Every method exit with relevant results

Use structured context (Sentry breadcrumbs, tags, extra data) so logs are searchable. Never log sensitive data (credentials, tokens).

### Class logger pattern

Every class gets a `private readonly logger` instance, created in the constructor as a child of the root logger with the class name and identifying context.

```ts
import { type Logger, logger } from "@autonoma/logger";

export class TestSuiteUpdater {
  private readonly logger: Logger;

  constructor(private readonly snapshotId: string) {
    this.logger = logger.child({ name: this.constructor.name, snapshotId });
  }

  public async apply(change: TestSuiteChange) {
    this.logger.info("Applying test suite change", { type: change.constructor.name });
    // ... do work ...
    this.logger.info("Finished applying change");
  }
}
```

### Function logger pattern - called from classes

If a reusable function is called from a class method, accept a `Logger` parameter to preserve the logging context chain.

```ts
import type { Logger } from "@autonoma/logger";

export function computeChanges(branchId: string, logger: Logger) {
  logger.info("Computing changes", { branchId });
  // ... do work ...
  logger.info("Changes computed", { count: changes.length });
  return changes;
}
```

### Function logger pattern - standalone files

If a file exports independently useful functions (not called from a single class), import the root logger and create a child per function.

```ts
import { logger as rootLogger } from "@autonoma/logger";

export function syncDevices(deviceIds: string[]) {
  const logger = rootLogger.child({ name: "syncDevices" });
  logger.info("Syncing devices", { count: deviceIds.length });
  // ... do work ...
  logger.info("Devices synced");
}
```

## Testing

### Philosophy

- **Vitest** for all tests
- **Prefer integration tests** over unit tests. Test the real thing, not mocks
- **Never mock the database.** Use Testcontainers with a real PostgreSQL container
- Only test what makes sense - don't test trivial getters

### Setup

Test files go in `test/` directories that mirror the `src/` structure. File naming: `*.test.ts`.

For integration tests that need a database, use the `@autonoma/integration-test` package:

```ts
import { integrationTestSuite } from "@autonoma/integration-test";

integrationTestSuite("MyService", (harness) => {
  it("should create a record", async () => {
    const db = harness.db;
    // ... test with a real database
  });
});
```

The harness spins up a real PostgreSQL container via Testcontainers, runs migrations, and gives you a fresh database for each test suite.

### Running tests

```bash
pnpm test              # run all tests
pnpm test --filter=ai  # run tests in a specific package
```

## Database transactions

Wrap sequential database queries in a Prisma `$transaction` when they must be consistent. If a service method reads then writes (or writes to multiple tables), use `$transaction`:

```ts
async createGeneration(userId: string, orgId: string, appId: string) {
  return await this.db.$transaction(async (tx) => {
    const app = await tx.application.findFirst({
      where: { id: appId, organizationId: orgId },
    });
    if (app == null) throw new Error("Application not found");

    const generation = await tx.applicationGeneration.create({
      data: { /* ... */ },
    });

    await tx.onboardingState.upsert({
      where: { applicationId: appId },
      /* ... */
    });

    return { id: generation.id };
  });
}
```

Pass `tx` to all queries inside the transaction - not the original `db` client.

## Adding dependencies

**Always check `pnpm-workspace.yaml` first.** The catalog section defines pinned versions for shared dependencies. When adding a dependency:

1. Check if it already exists in the `catalog:` section
2. If it does, use `"catalog:"` as the version in `package.json`
3. If it doesn't, consider whether it should be added to the catalog (used by multiple packages) or pinned locally

```jsonc
// Good - uses catalog version
"dependencies": {
  "zod": "catalog:"
}

// Bad - hardcodes a version when a catalog entry exists
"dependencies": {
  "zod": "^3.23.0"
}
```

## Environment variables

Never read `process.env` directly. Define all environment variables in a dedicated `env.ts` file using `createEnv` from `@t3-oss/env-core` with Zod schemas:

```ts
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    BETTER_AUTH_SECRET: z.string().min(1),
  },
  runtimeEnv: process.env,
});
```

This gives you type safety, runtime validation, and a single source of truth for all required variables. Pass validated env values as function parameters rather than reading `process.env` in library code.
