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
| `METRICS_PORT` | No | `9464` | Dedicated port for the Prometheus `/metrics` endpoint (kept off `API_PORT` so the ingress never exposes it) |
| `GOOGLE_CLIENT_ID` | Yes | - | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | - | Google OAuth client secret |
| `REDIS_URL` | Yes | - | Redis connection URL (sessions, caching) |
| `APP_URL` | No | `http://localhost:3000` | Frontend URL for redirects |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000` | Comma-separated CORS origins |
| `INTERNAL_DOMAIN` | No | `autonoma.app` | Domain for internal users and cross-subdomain cookies |
| `AGENT_VERSION` | No | `latest` | Version tag for Temporal worker agent images |
| `POSTHOG_KEY` | No | - | PostHog API key (analytics disabled if absent) |
| `POSTHOG_HOST` | No | `https://us.i.posthog.com` | PostHog ingest host |
| `LLM_PROXY_ENABLED` | No | `false` | Master switch for the managed LLM proxy (`/v1/llm-proxy`, planner CLI). Mounted only when this AND `STRIPE_ENABLED` are true. |
| `OPENROUTER_API_KEY` | No | - | Server-side OpenRouter key the LLM proxy forwards with. Required for the proxy (`503` without it). |
| `LLM_PROXY_ALLOWED_MODELS` | No | planner model | Comma-separated allowlist of models the proxy may route. Defaults to `google/gemini-3-flash-preview`. |
| `GITHUB_PR_CACHE_REVALIDATE_WINDOW_MINUTES` | No | `5` | Throttle window for the read-triggered PR-metadata cache revalidate (per app); one open-list call, plus one closed-list call when PRs need merged-vs-closed classification |
| `TESTING` | No | `false` | Test environment flag - prevents loading production modules |

Additionally, the inherited env schemas require database (`DATABASE_URL`), logger (`SENTRY_DSN`, `NODE_ENV`), and storage (`S3_BUCKET`, AWS credentials) variables.

## Prometheus Metrics

The API serves a Prometheus endpoint on `METRICS_PORT` (`src/metrics/metrics-server.ts`), scraped pod-direct via the `prometheus.io/*` annotations in `deployment/apps/api.yaml` - it is never routed through the Service or ingress. It exposes:

- Node.js process metrics (prom-client `collectDefaultMetrics`).
- `previewkit_app_builds_in_flight` (`src/metrics/previewkit-build-metrics.ts`): app image builds this env's previewkit runners currently have running on the shared warm buildkit pool, computed from the DB on each scrape (fresh `building` app rows on live environments; a 90-minute freshness window ages out rows leaked by a crashed runner). Every env's API exports its own view; the `previewkit:app_builds_in_flight:sum` recording rule (`deployment/prometheus/alert-rules.yaml`) dedupes replicas and sums envs into the pool-wide series that dashboards and autoscaling read.

## Architecture

### Request Flow

```
Hono HTTP server
  ├── /health              - health check
  ├── /v1/auth/**          - better-auth (Google OAuth, sessions)
  ├── /v1/github/**        - GitHub webhooks and API endpoints
  ├── /v1/previewkit/**    - Previewkit environments + secrets (secrets/status/schema native; deploy/teardown/redeploy forwarded to Previewkit)
  ├── /v1/setup/**         - test planner setup (API key): setups, events, artifacts, scenario-recipe-versions
  ├── /v1/llm-proxy/**     - managed LLM proxy for the planner CLI (API key): chat/completions
  └── /v1/trpc/*           - tRPC fetch adapter
```

### Managed LLM proxy (`/v1/llm-proxy`)

The planner CLI (`@autonoma-ai/planner`) runs on managed Autonoma credits instead of a
user-supplied OpenRouter key. It points its OpenRouter AI-SDK provider at
`${AUTONOMA_API_URL}/v1/llm-proxy` and authenticates with its Autonoma API token (same
`requireApiKey` path as `/v1/setup`).

The route is gated on `LLM_PROXY_ENABLED` (default `false`) so it is never an accidental
unmetered gateway - it is only mounted where explicitly enabled. Metering requires
`STRIPE_ENABLED=true`; when the proxy is enabled with billing off (e.g. a test environment)
requests are served but **not** metered and a startup warning is logged. The proxy:

1. Gates on the org having a positive credit balance (`402 out_of_credits` otherwise).
2. Enforces a model allowlist (`LLM_PROXY_ALLOWED_MODELS`, default = the single model the planner uses, `google/gemini-3-flash-preview`).
3. Forwards `chat/completions` to OpenRouter with the server `OPENROUTER_API_KEY`, streaming the
   response back unchanged.
4. Meters the dollar cost OpenRouter reports (usage accounting) into credits at the top-up rate and
   deducts from `BillingCustomer.creditBalance`, recording a `LLM_PROXY_CONSUMPTION` transaction
   (idempotent on the OpenRouter generation id). Surfaced in the billing UI as "AI CLI usage".

Returns `503` when `OPENROUTER_API_KEY` is unset.

**Known limitation (concurrency):** the balance gate and the deduction are separate reads, so an
org near zero balance that fires N concurrent requests can have all N served (each costing real
OpenRouter tokens) while the balance only floors at zero. Per-call cost is tiny and the gate still
blocks once the wallet is empty, so the overspend is bounded; tighten with per-API-key rate limiting
(the `ApiKey` model already carries `rateLimit*` fields) or an atomic check-and-reserve if CLI volume
grows.

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
