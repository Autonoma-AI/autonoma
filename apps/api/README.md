# @autonoma/api

Backend API server for the Autonoma platform. Exposes a tRPC API over HTTP with Google OAuth authentication, GitHub webhook handling, and organization-based multi-tenancy.

## Tech Stack

- **Runtime:** Node 22 (ESM-only)
- **HTTP Framework:** Hono
- **API Layer:** tRPC with SuperJSON transformer
- **Auth:** better-auth (Google OAuth, session-based, Redis-backed)
- **Database:** PostgreSQL via Prisma (`@autonoma/db`)
- **Storage:** S3 via `@autonoma/storage`
- **Observability:** Sentry (logging, error tracking, tracing)
- **Analytics:** PostHog via `@autonoma/analytics`
- **Build:** tsup (bundled ESM, targets Node 22)

## Running

```bash
# From the monorepo root
pnpm dev           # starts API (port 4000) and UI (port 3000) concurrently

# From this directory
pnpm dev           # starts API with --env-file=../../.env and tsx watch
pnpm build         # production build via tsup
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check with auto-fix
pnpm test          # unit tests (vitest)
pnpm test:integration  # integration tests (vitest, Testcontainers)
```

## Environment Variables

Defined in `src/env.ts` using `@t3-oss/env-core` with Zod validation. Also extends env schemas from `@autonoma/db`, `@autonoma/logger`, and `@autonoma/storage`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_PORT` | Yes | - | Port the server listens on (typically `4000`) |
| `GOOGLE_CLIENT_ID` | Yes | - | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | - | Google OAuth client secret |
| `REDIS_URL` | Yes | - | Redis connection URL (sessions, caching) |
| `APP_URL` | No | `http://localhost:3000` | Frontend URL for redirects |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000` | Comma-separated CORS origins |
| `INTERNAL_DOMAIN` | No | `autonoma.app` | Domain for internal users and cross-subdomain cookies |
| `AGENT_VERSION` | No | `latest` | Version tag for Argo workflow agent images |
| `POSTHOG_KEY` | No | - | PostHog API key (analytics disabled if absent) |
| `POSTHOG_HOST` | No | `https://us.i.posthog.com` | PostHog ingest host |
| `LOCAL_GENERATION` | No | `false` | Run test generation locally instead of via Argo |
| `LOCAL_GENERATION_CONCURRENCY` | No | `2` | Concurrency limit for local generation |
| `TESTING` | No | `false` | Test environment flag - prevents loading production modules |

Additionally, the inherited env schemas require database (`DATABASE_URL`), logger (`SENTRY_DSN`, `NODE_ENV`), and storage (`S3_BUCKET`, AWS credentials) variables.

## Architecture

### Request Flow

```
Hono HTTP server
  ├── /health              - health check
  ├── /v1/auth/**          - better-auth (Google OAuth, sessions)
  ├── /v1/github/**        - GitHub webhooks and API endpoints
  └── /v1/trpc/*           - tRPC fetch adapter
```

### tRPC Routers

Each router is thin wiring - business logic lives in the corresponding service class. Routers are defined in `src/routes/` and composed in `src/routes/router.ts`.

| Router | Service | Domain |
|--------|---------|--------|
| `admin` | `AdminService` | Admin operations |
| `auth` | `AuthService` | User and session management |
| `applications` | `ApplicationsService` | Test target applications |
| `branches` | `BranchesService` | Test suite branches |
| `folders` | `FoldersService` | Test organization |
| `runs` | `RunsService` | Test execution runs |
| `generations` | `TestGenerationsService` | AI test generation |
| `tests` | `TestsService` | Test cases |
| `scenarios` | `ScenariosService` | Execution scenarios |
| `skills` | `SkillsService` | AI skills |
| `github` | `GitHubInstallationService` | GitHub app integrations |
| `issues` | `IssuesService` | Test issues and reviews |
| `onboarding` | `OnboardingService` | User onboarding |
| `snapshotEdit` | `SnapshotEditService` | Snapshot editing |

### Procedure Types

Defined in `src/trpc.ts`:

- **`publicProcedure`** - No auth required. Has Sentry tracing and error mapping middleware.
- **`protectedProcedure`** - Requires authenticated user with an active organization.
- **`internalProcedure`** - Requires admin role.

### Error Handling

Custom `APIError` subclasses (`NotFoundError`, `ConflictError`, `BadRequestError`, `InternalError`) are automatically mapped to tRPC error codes via middleware. Unhandled errors are logged as fatal via Sentry.

### Dependency Injection

Services are built in `src/routes/build-services.ts` via plain constructor injection - no DI framework. The `createContext` function in `src/context.ts` assembles the full tRPC context (database, auth session, services) for each request.
