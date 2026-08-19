# @autonoma/db

Prisma schema, generated client, and database utilities for PostgreSQL. This package is the single source of truth for the database schema across the entire monorepo.

## What's Inside

```
packages/db/
├── prisma/
│   ├── schema.prisma        # Database schema
│   └── migrations/          # Prisma migration history
├── src/
│   ├── index.ts             # Singleton PrismaClient, createClient(), applyMigrations()
│   ├── env.ts               # DATABASE_URL validation via createEnv
│   ├── previewkit-config-rows.ts  # Include shape + nested writes for the normalized preview config
│   ├── seed.ts              # Development seed data (orgs, users, apps, test cases, runs)
│   └── generated/prisma/    # Auto-generated Prisma client (do not edit)
└── prisma.config.ts         # Prisma CLI configuration
```

## Usage

### Importing the Client

```ts
import { db } from "@autonoma/db";

const users = await db.user.findMany();
```

The default `db` export is a lazy singleton - it reads `DATABASE_URL` from the environment on first access.

### Creating a Custom Client

Use `createClient` when you need a client with a specific connection string (e.g., in tests or jobs):

```ts
import { createClient } from "@autonoma/db";

const client = createClient("postgresql://user:pass@host:5432/mydb");
```

### Applying Migrations Programmatically

For Testcontainers or custom setups where you need to run migrations at runtime:

```ts
import { applyMigrations } from "@autonoma/db";

applyMigrations(connectionString, true); // verbose = true for stdout
```

### Re-exporting Types and Enums

All generated Prisma types and enums are re-exported from the package root:

```ts
import { type User, ApplicationArchitecture, GenerationStatus } from "@autonoma/db";
```

## Commands

All commands are run from the `packages/db` directory, or from the monorepo root using the `pnpm` filter.

| Command | Description |
|---------|-------------|
| `pnpm db:generate` | Regenerate the Prisma client after schema changes |
| `pnpm db:migrate` | Create and apply a new migration (interactive - prompts for name) |
| `pnpm db:seed` | Seed the database with mock development data |
| `pnpm db -- migrate deploy` | Apply pending migrations without creating new ones (production) |

The `pnpm db` script is a passthrough to the `prisma` CLI with `DATABASE_URL` loaded from the root `.env` file via `dotenv-cli`.

## Schema Changes Workflow

1. Edit `prisma/schema.prisma`.
2. Run `pnpm db:migrate` - this creates a new migration file and applies it.
3. Run `pnpm db:generate` - this regenerates the TypeScript client in `src/generated/prisma/`.
4. Commit both the migration file and the updated generated client.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (validated with Zod via `@t3-oss/env-core`) |

The `env.ts` file validates `DATABASE_URL` at runtime using `createEnv`. A placeholder URL is used during `postinstall` so that `prisma generate` works without a real database.

## Architecture Notes

- **PostgreSQL adapter** - Uses `@prisma/adapter-pg` (the `pg` driver adapter) rather than Prisma's default query engine.
- **JSON type safety** - Uses `prisma-json-types-generator` to provide typed JSON columns (e.g., `ModelConversation`, `ScenarioAuth`). Types are declared in `src/index.ts` under the global `PrismaJson` namespace.
- **Lazy singleton** - The `db` export uses a `Proxy` to defer client creation until first property access, avoiding connection attempts during import.
- **ESM only** - Like all packages in the monorepo, this is ESM-only (`"type": "module"`).
- **Generated code** - Everything under `src/generated/` is auto-generated. Never edit these files directly.
- **Preview config is relational** - An Application's preview topology lives in `previewkit_config` and its child tables (apps, connections, services, setup tasks, repositories, hooks), not in one JSON blob. Read it with `previewkitConfigRowsInclude` and compose the config document with `documentFromPreviewkitConfigRows` from `@autonoma/types`; write it with `previewkitConfigCreateChildren` / `previewkitConfigReplaceChildren`. Build strategy blocks (`build`, `blueprint`), service `options`, and setup-task `location` stay JSON on their row - they churn independently and nothing queries inside them.
