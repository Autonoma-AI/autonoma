---
title: Environment Variables
description: Complete reference for every environment variable used across the Autonoma AI monorepo - API server, frontend, AI services, database, storage, logging, billing, and infrastructure.
---

## Quick Start - Minimum for Local Development

To get the API and UI running locally, you need a surprisingly small set of variables. Copy `.env.example` to `.env` at the repo root and fill in these essentials:

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/autonoma

# Redis
REDIS_URL=redis://localhost:6379

# API server
API_PORT=4000
SCENARIO_ENCRYPTION_KEY=any-string-at-least-1-char

# Google OAuth (create credentials at console.cloud.google.com)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# AI model keys (needed for test execution)
GEMINI_API_KEY=your-gemini-key
GROQ_KEY=your-groq-key
OPENROUTER_API_KEY=your-openrouter-key

# S3-compatible storage (can use MinIO locally)
S3_BUCKET=autonoma-local
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_ENDPOINT=http://localhost:9000
```

Everything else has sensible defaults or is optional for local development. The sections below cover every variable in detail.

## How Environment Variables Work in This Project

Every app and package defines its environment variables in a dedicated `env.ts` file using [`createEnv` from `@t3-oss/env-core`](https://env.t3.gg/). This gives you:

- **Zod validation at startup** - the process crashes immediately if a required variable is missing or malformed, rather than failing mysteriously at runtime.
- **Type safety** - `env.DATABASE_URL` is typed as `string`, not `string | undefined`. No more `process.env.DATABASE_URL!` casts.
- **Composability** - packages export their `env` object, and apps extend them. For example, the API server's `env.ts` extends the database, storage, logger, and billing envs, inheriting all their variables.

You should **never read `process.env` directly** in application code. Always import from the nearest `env.ts`:

```ts
// Good
import { env } from "./env";
const port = env.API_PORT;

// Bad - bypasses validation
const port = process.env.API_PORT;
```

The `emptyStringAsUndefined: true` option is enabled everywhere, so setting a variable to an empty string is treated the same as not setting it at all.

For boolean variables, the codebase uses `z.stringbool()` which accepts `"true"`, `"false"`, `"1"`, `"0"`, `"yes"`, and `"no"`.

---

## Core API Server

**Source:** `apps/api/src/env.ts`

The API server extends the database, storage, logger, and billing environments, so all variables from those sections apply here too.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `API_PORT` | Yes | - | Port the API server listens on. Typically `4000`. |
| `INTERNAL_DOMAIN` | No | `autonoma.app` | Internal domain used for routing and service discovery. |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000` | Comma-separated list of CORS origins. Must include the frontend URL. |
| `SCENARIO_ENCRYPTION_KEY` | Yes | - | Key used to encrypt scenario data. Any non-empty string works for local dev. |
| `GOOGLE_CLIENT_ID` | Yes | - | OAuth 2.0 client ID from Google Cloud Console. Required for user authentication. |
| `GOOGLE_CLIENT_SECRET` | Yes | - | OAuth 2.0 client secret from Google Cloud Console. |
| `AGENT_VERSION` | No | `latest` | Version tag for the execution agent. Used when dispatching engine jobs. |
| `POSTHOG_KEY` | No | - | PostHog project API key for server-side analytics. Omit to disable analytics. |
| `POSTHOG_HOST` | No | `https://us.i.posthog.com` | PostHog ingestion endpoint. Override for self-hosted PostHog instances. |
| `GEMINI_API_KEY` | Yes | - | Google Gemini API key. Used by the API for AI features like test generation. |
| `REDIS_URL` | Yes | - | Redis connection string (e.g., `redis://localhost:6379`). Used for device locking, caching, and pub/sub. |
| `LOCAL_GENERATION` | No | `false` | When `true`, runs test generation locally instead of dispatching to Kubernetes jobs. Useful for development. |
| `LOCAL_GENERATION_CONCURRENCY` | No | `2` | Maximum number of concurrent local generation workers when `LOCAL_GENERATION` is enabled. |
| `TESTING` | No | `false` | Set to `true` in test environments. Prevents importing certain modules. Not for general use. |
| `ENGINE_BILLING_SECRET` | No | - | Shared secret for authenticating billing calls from the engine. |

---

## Frontend (UI)

**Source:** `apps/ui/src/env.ts`

The frontend uses Vite's `import.meta.env` and requires the `VITE_` prefix for all variables.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VITE_API_URL` | No | `http://localhost:4000` | URL of the API server. The frontend makes all tRPC calls to this address. |
| `VITE_INTERNAL_DOMAIN` | No | `autonoma.app` | Internal domain, used for UI routing logic. |
| `VITE_ARGO_URL` | No | - | URL of the Argo Workflows UI. When set, enables links to workflow runs in the dashboard. |
| `VITE_SENTRY_DSN` | No | - | Sentry DSN for frontend error tracking. Omit to disable Sentry in the browser. |
| `VITE_SENTRY_URL` | No | - | Sentry organization URL. Used for linking to Sentry issues from the UI. |
| `VITE_POSTHOG_KEY` | No | - | PostHog project API key for frontend analytics. Omit to disable analytics. |
| `VITE_POSTHOG_HOST` | No | `https://us.i.posthog.com` | PostHog ingestion endpoint for the frontend. |

---

## Database

**Source:** `packages/db/src/env.ts`

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string. Format: `postgresql://user:password@host:port/database`. Used by Prisma for all database operations. |

:::note
For local development, a typical value is `postgresql://postgres:postgres@localhost:5432/autonoma`. Make sure PostgreSQL is running and the database exists before starting the API.
:::

---

## AI Services

**Source:** `packages/ai/src/env.ts`

These keys are required by the execution engines (web and mobile) and any service that runs AI inference. The API server only needs `GEMINI_API_KEY` directly - the other keys are consumed by the engine apps.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Yes | - | Google Gemini API key. Used for the primary model (Gemini 3 Flash/Pro), point detection, object detection, and visual condition checking. |
| `GROQ_KEY` | Yes | - | Groq API key. Used for fast inference with open-source models (e.g., GPT-OSS-120B). |
| `OPENROUTER_API_KEY` | Yes | - | OpenRouter API key. Provides access to Ministral-8B and serves as a fallback provider for open-source models. |

:::note
Validation is skipped when running in Vitest (`VITEST` env var is set), so you do not need these keys to run unit tests.
:::

---

## Storage (S3)

**Source:** `packages/storage/src/env.ts`

Used for storing screenshots, video recordings, test artifacts, and other binary assets.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `S3_BUCKET` | Yes | - | S3 bucket name for storing artifacts. |
| `S3_REGION` | Yes | - | AWS region of the S3 bucket (e.g., `us-east-1`). |
| `S3_ACCESS_KEY_ID` | Yes | - | AWS access key ID (or MinIO equivalent) for S3 authentication. |
| `S3_SECRET_ACCESS_KEY` | Yes | - | AWS secret access key (or MinIO equivalent) for S3 authentication. |
| `S3_ENDPOINT` | No | - | Optional custom endpoint URL for S3-compatible providers. Set this to `http://localhost:9000` when using local MinIO. |

:::tip[Local development with MinIO]
Autonoma's default `docker compose up -d` path starts [MinIO](https://min.io/) on `http://localhost:9000`, creates the `autonoma-local` bucket, and configures MinIO API CORS for `http://localhost:3000` and `http://127.0.0.1:3000` so signed screenshot and video URLs load in the local UI.

If your UI runs on a different origin, update the `cors_allow_origin` list in `docker-compose.yaml` and rerun the `minio-init` service.
:::

---

## Logging and Observability

**Source:** `packages/logger/src/env.ts`

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | Node environment. Accepts `development`, `production`, or `test`. Affects log formatting and behavior. |
| `SENTRY_DSN` | No | - | Sentry DSN for backend error tracking and performance monitoring. Omit to disable Sentry. |
| `SENTRY_ENV` | No | `production` | Sentry environment tag (e.g., `staging`, `production`). |
| `SENTRY_RELEASE` | No | `unknown` | Sentry release identifier. Typically set to the git SHA or version tag in CI. |
| `DEBUG` | No | - | Debug filter string. When set, enables verbose debug logging for matching namespaces (e.g., `autonoma:*`). |

---

## Billing (Stripe)

**Source:** `packages/billing/src/env.ts`

Billing is entirely optional. When `STRIPE_ENABLED` is `false` (the default), all billing features are disabled and no other Stripe variables are needed.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `STRIPE_ENABLED` | No | `false` | Master switch for billing. Set to `true` to enable Stripe integration. |
| `STRIPE_SECRET_KEY` | No | - | Stripe secret API key. Required when `STRIPE_ENABLED` is `true`. |
| `STRIPE_WEBHOOK_SECRET` | No | - | Stripe webhook signing secret for verifying incoming webhook events. Required when `STRIPE_ENABLED` is `true`. |
| `STRIPE_SUBSCRIPTION_PRICE_ID` | No | - | Stripe Price ID for the subscription plan. Required when `STRIPE_ENABLED` is `true`. |
| `STRIPE_TOPUP_PRICE_ID` | No | - | Stripe Price ID for credit top-up purchases. Required when `STRIPE_ENABLED` is `true`. |
| `BILLING_GRACE_PERIOD_DAYS` | No | `3` | Number of days after a subscription lapses before access is revoked. |
| `APP_URL` | No | `http://localhost:3000` | Frontend application URL. Used in Stripe checkout redirect URLs and billing emails. |

---

## Kubernetes and Workflows

**Source:** `packages/k8s/src/env.ts` and `packages/workflow/src/env.ts`

These variables are only needed in production or when running engine jobs on Kubernetes. Not required for local development.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NAMESPACE` | Yes (in K8s) | - | Kubernetes namespace where jobs and workflows are deployed. Used by both `@autonoma/k8s` and `@autonoma/workflow`. |

The workflow package also reads:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string. The workflow package needs direct DB access for job coordination. |
| `SENTRY_ENV` | No | - | Sentry environment tag for workflow jobs. |

---

## Engine - Web (Playwright)

**Source:** `apps/engine-web/src/platform/env.ts` and `apps/engine-web/src/execution-agent/env.ts`

The web engine extends the AI, database, logger, and storage environments. All variables from those sections apply.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `REMOTE_BROWSER_URL` | No | - | WebSocket URL of a remote browser instance (e.g., Browserless or Playwright remote). When omitted, launches a local Chromium browser. |
| `HEADLESS` | No | - | Set to any value to run Playwright in headless mode. When omitted, the browser window is visible (useful for local debugging). |

---

## Engine - Mobile (Appium)

**Source:** `apps/engine-mobile/src/platform/env.ts`

The mobile engine extends the AI, database, logger, and storage environments. All variables from those sections apply.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `APPIUM_HOST` | No | - | Hostname of the Appium server. |
| `APPIUM_PORT` | No | - | Port of the Appium server. |
| `APPIUM_MJPEG_PORT` | No | - | Port for the Appium MJPEG video stream. Used for live frame capture during test execution. |
| `APPIUM_SYSTEM_PORT` | No | - | System port used by Appium's UiAutomator2 (Android) or WebDriverAgent (iOS). |
| `APPIUM_SKIP_INSTALLATION` | No | `true` | When `true`, skips reinstalling the app before each test. Speeds up repeated runs on the same device. |
| `DEVICE_NAME` | No | - | Name of the target device or emulator (e.g., `iPhone 15 Pro`, `Pixel 7`). |
| `IOS_PLATFORM_VERSION` | No | - | iOS version to target (e.g., `17.2`). Required for iOS testing. |
| `ANDROID_DAEMON_HOSTS` | No | - | Comma-separated list of Android daemon host addresses for distributed device access. |
| `IOS_DAEMON_HOSTS` | No | - | Comma-separated list of iOS daemon host addresses for distributed device access. |
| `SKIP_DEVICE_DATE_UPDATE` | No | `false` | When `true`, skips updating the device date/time before tests. Useful when the device clock is already correct. |

---

## Jobs

### Execution Agent Runner

**Source:** `packages/engine/src/execution-agent/runner/env.ts`

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ARTIFACT_DIR` | No | - | Local directory for saving test artifacts (screenshots, videos, step logs). Used by the local runner during development. |

### Run Completion Notification

**Source:** `apps/jobs/run-completion-notification/src/env.ts`

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string. |
| `API_URL` | No | - | API server URL for callbacks. |
| `ENGINE_BILLING_SECRET` | No | - | Shared secret for authenticating billing-related calls. |
| `STRIPE_ENABLED` | No | `false` | Whether to process billing events on run completion. |

### Test Case Generator

**Source:** `apps/jobs/test-case-generator/src/env.ts`

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `REPOSITORY_ID` | Yes | - | Identifier for the test case repository being generated. |
| `AGENT_VERSION` | No | `latest` | Version tag for the generation agent. |
| `SENTRY_DSN` | No | - | Sentry DSN for error tracking in the generator job. |
| `SENTRY_ENV` | No | - | Sentry environment tag. |
| `APP_URL` | No | - | Application URL. Used for generating links in notifications. |

### Diffs

**Source:** `apps/jobs/diffs/src/env.ts`

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BRANCH_ID` | Yes | - | Branch identifier for computing diffs. |
| `GEMINI_API_KEY` | Yes | - | Gemini API key for AI-powered diff analysis. |
| `GITHUB_APP_ID` | Yes | - | GitHub App ID for repository access. |
| `GITHUB_APP_PRIVATE_KEY` | Yes | - | GitHub App private key (PEM format). |
| `GITHUB_APP_WEBHOOK_SECRET` | Yes | - | GitHub App webhook secret for verifying events. |
| `AGENT_VERSION` | No | `latest` | Version tag for the diff agent. |

### Generation Assigner

**Source:** `apps/jobs/generation-assigner/src/env.ts`

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AUTO_ACTIVATE` | No | - | When set, automatically activates generated test cases without manual review. |

### Review Jobs (Generation Reviewer, Replay Reviewer)

**Source:** `packages/review/src/env.ts`

Both the generation reviewer and replay reviewer jobs re-export from `@autonoma/review/env`, which extends the AI, logger, and storage environments. No additional variables beyond those from the AI, logger, and storage sections.

---

## GitHub App

These variables appear in `.env.example` and are used by the API server and the diffs job for GitHub integration features (repository connections, PR-triggered test runs).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | No | - | GitHub App ID. Required for GitHub integration features. |
| `GITHUB_APP_PRIVATE_KEY` | No | - | GitHub App private key in PEM format. |
| `GITHUB_APP_WEBHOOK_SECRET` | No | - | Secret for verifying GitHub webhook payloads. |
| `GITHUB_APP_SLUG` | No | - | GitHub App slug (URL-friendly name). Used for generating installation links. |

---

## Authentication

These variables are referenced in `.env.example` for the Better Auth integration used by the API server.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | Yes | - | Secret key for Better Auth session signing. Generate with `openssl rand -hex 32`. |
| `BETTER_AUTH_URL` | Yes | - | Base URL of the API server (e.g., `http://localhost:4000`). Used by Better Auth for callback URLs. |

---

## Tips for Local Development

**What you can skip entirely:**

- **Billing** - Leave `STRIPE_ENABLED=false` (the default). No Stripe keys needed.
- **Analytics** - Omit `POSTHOG_KEY` and `VITE_POSTHOG_KEY`. Analytics calls become no-ops.
- **Sentry** - Omit `SENTRY_DSN` and `VITE_SENTRY_DSN`. Error tracking is disabled gracefully.
- **Kubernetes** - Omit `NAMESPACE`. Only needed when deploying to K8s.
- **GitHub App** - Omit all `GITHUB_APP_*` variables unless you are working on GitHub integration.
- **Argo Workflows** - Omit `VITE_ARGO_URL`. The UI hides workflow links when this is unset.

**What uses defaults that just work:**

- `ALLOWED_ORIGINS` defaults to `http://localhost:3000` - correct for local dev.
- `VITE_API_URL` defaults to `http://localhost:4000` - correct for local dev.
- `APP_URL` defaults to `http://localhost:3000` - correct for local dev.
- `NODE_ENV` defaults to `development`.
- `AGENT_VERSION` defaults to `latest`.
- `LOCAL_GENERATION` defaults to `false`. Set to `true` if you want to run test generation without K8s.

**What you must provide:**

- `DATABASE_URL` - there is no default. You need a running PostgreSQL instance.
- `REDIS_URL` - there is no default. You need a running Redis instance.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` - required for authentication. Create OAuth credentials in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
- `SCENARIO_ENCRYPTION_KEY` - any non-empty string works locally.
- `BETTER_AUTH_SECRET` - generate one with `openssl rand -hex 32`.
- `BETTER_AUTH_URL` - set to `http://localhost:4000`.
- AI keys (`GEMINI_API_KEY`, `GROQ_KEY`, `OPENROUTER_API_KEY`) - required if you are running test execution. Not needed if you are only working on the UI or API without triggering test runs.
- S3 credentials - required for artifact storage. Use MinIO locally.
