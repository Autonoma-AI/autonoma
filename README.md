# Autonoma AI

Agentic end-to-end testing platform. Create and run automated tests for web, iOS, and Android applications using natural language. Tests execute on real devices and browsers with AI-powered element detection, assertions, and self-healing.

## Architecture

```
apps/
  api/              Hono + tRPC API server (port 4000)
  ui/               Vite + React 19 SPA (port 3000)
  engine-web/       Playwright-based web test execution
  engine-mobile/    Appium-based mobile test execution (iOS + Android)
  docs/             Astro Starlight documentation site
  jobs/             Background jobs (reviewer, notifier, test-case-generator)

packages/
  ai/               AI primitives - model registry, vision, point/object detection
  db/               Prisma schema + generated client (PostgreSQL)
  types/            Shared Zod schemas and TypeScript types
  engine/           Platform-agnostic execution agent core
  device-lock/      Redis-based distributed device locking
  blacklight/       Shared UI component library (Radix + Tailwind + CVA)
  try/              Go-style error handling (fx.runAsync, fx.run)
  storage/          S3 file storage
  logger/           Sentry-based logging
  analytics/        PostHog server-side analytics
  k8s/              Kubernetes helpers
  workflow/         Argo workflow builders
  utils/            Shared utilities
```

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [pnpm](https://pnpm.io/) 10.x (`corepack enable` to use the version pinned in `package.json`)
- [Docker](https://www.docker.com/) (for PostgreSQL, Redis, and MinIO)

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/autonoma-ai/autonoma.git
cd autonoma
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Start infrastructure

PostgreSQL, Redis, and MinIO run via Docker Compose:

```bash
docker compose up -d
```

This starts:
- **PostgreSQL 18** on `localhost:5432` (user: `postgres`, password: `postgres`)
- **Redis** on `localhost:6379`
- **MinIO** on `localhost:9000` (console on `http://localhost:9001`)
- The `autonoma-local` bucket plus MinIO API CORS for local UI media access

### 4. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in the required values. At minimum for local development you need:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgresql://postgres:postgres@localhost:5432/autonoma` |
| `REDIS_URL` | Redis connection string, e.g. `redis://localhost:6379` |
| `BETTER_AUTH_SECRET` | Any random string for session signing |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GEMINI_API_KEY` | Google Gemini API key (for AI features) |
| `S3_BUCKET` | Local artifact bucket name, defaults to `autonoma-local` in `.env.example` |
| `S3_REGION` | S3 region, defaults to `us-east-1` in `.env.example` |
| `S3_ACCESS_KEY_ID` | MinIO access key, defaults to `minioadmin` in `.env.example` |
| `S3_SECRET_ACCESS_KEY` | MinIO secret key, defaults to `minioadmin` in `.env.example` |
| `S3_ENDPOINT` | Local MinIO endpoint, defaults to `http://localhost:9000` in `.env.example` |

See `.env.example` for the full list of variables grouped by service.

### 5. Set up the database

Generate the Prisma client and run migrations:

```bash
pnpm db:generate
pnpm db:migrate
```

### 6. Start development servers

```bash
pnpm dev
```

This starts both the API server (port 4000) and UI (port 3000) concurrently.

To run them individually:

```bash
pnpm api    # API only (port 4000)
pnpm ui     # UI only (port 3000)
```

## Commands

| Command | Description |
|---|---|
| `pnpm dev` | Start API + UI in development mode |
| `pnpm build` | Build all packages and apps |
| `pnpm typecheck` | Run TypeScript type checking across all packages |
| `pnpm lint` | Lint all packages |
| `pnpm test` | Run tests across all packages |
| `pnpm format` | Format code with Biome |
| `pnpm check` | Lint and format with Biome |
| `pnpm db:generate` | Generate Prisma client from schema |
| `pnpm db:migrate` | Run database migrations |
| `pnpm docs` | Start the documentation site (port 4321) |

## How it works

1. **Users write tests in natural language** - describe what to test (e.g. "Log in, navigate to settings, and verify the profile picture is visible")
2. **The execution agent interprets the instructions** - an AI agent loop takes a screenshot, decides which action to perform, executes it, and repeats until the test is complete
3. **Actions run on real browsers/devices** - Playwright drives web browsers, Appium drives iOS and Android devices
4. **AI handles element detection** - instead of CSS selectors or XPaths, the agent uses vision models to locate UI elements from natural language descriptions
5. **Results include video recordings, screenshots, and step-by-step logs** - every test run produces artifacts for debugging and review

### Execution flow

```
Natural language test
        |
   Execution Agent (packages/engine)
        |
   Screenshot -> LLM decides action -> Execute command -> Record step
        |                                    |
   Point detection (packages/ai)    Platform drivers
        |                              |            |
   Gemini / Moondream           Playwright      Appium
                                 (web)         (mobile)
```

### Test format

Tests are defined as Markdown files with YAML frontmatter:

```markdown
---
url: https://example.com
---
Navigate to the login page, enter "user@test.com" and "password123",
click Sign In, and assert the dashboard is visible.
```

## Tech stack

- **Runtime** - Node.js 24, ESM-only
- **Monorepo** - pnpm workspaces + Turborepo
- **Language** - TypeScript (strictest configuration)
- **API** - Hono + tRPC
- **Frontend** - React 19 + Vite + TanStack Router
- **Database** - PostgreSQL + Prisma
- **Cache/Locking** - Redis
- **AI** - Gemini, Groq, OpenRouter (via Vercel AI SDK)
- **Web Testing** - Playwright
- **Mobile Testing** - Appium
- **Styling** - Tailwind CSS v4 + Radix UI
- **Observability** - Sentry
- **Analytics** - PostHog
- **Deployment** - Kubernetes + Argo Workflows
