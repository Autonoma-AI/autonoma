---
title: Development Setup
description: How to get Autonoma AI running locally - from prerequisites through a working dev environment.
---

## Prerequisites

You need three things installed before starting:

| Tool | Version | How to get it |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | >= 24 | Use [nvm](https://github.com/nvm-sh/nvm) or download directly |
| [pnpm](https://pnpm.io/) | 10.x | Run `corepack enable` - the version is pinned in `package.json` |
| [Docker](https://www.docker.com/) | Latest | Docker Desktop or Docker Engine |

**Optional tools** (only needed if you're working on specific engines):

- [Playwright](https://playwright.dev/) - for `engine-web` development
- [Appium](https://appium.io/) - for `engine-mobile` development

## Clone and install

```bash
git clone https://github.com/autonoma-ai/autonoma.git
cd autonoma
pnpm install
```

`pnpm install` handles the entire monorepo - all apps and packages get their dependencies in one pass.

## Start infrastructure

PostgreSQL, Redis, and MinIO run via Docker Compose:

```bash
docker compose up -d
```

This starts:

- **PostgreSQL 18** on `localhost:5432` (user: `postgres`, password: `postgres`)
- **Redis** on `localhost:6379`
- **MinIO** on `localhost:9000` (console on `http://localhost:9001`)
- The `autonoma-local` bucket and MinIO API CORS for loading local screenshots and videos in the UI

Verify they're running:

```bash
docker compose ps
```

Both containers should show `running` status.

## Environment variables

Copy the example file and fill in the required values:

```bash
cp .env.example .env
```

### Minimum required variables

| Variable | Description | Where to get it |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | Use `postgresql://postgres:postgres@localhost:5432/autonoma` for the Docker Compose setup |
| `REDIS_URL` | Redis connection string | Use `redis://localhost:6379` for the Docker Compose setup |
| `BETTER_AUTH_SECRET` | Session signing secret | Generate any random string: `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | Create OAuth credentials in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Set the authorized redirect URI to `http://localhost:4000/api/auth/callback/google` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | Same Google Cloud Console OAuth credentials page |
| `GEMINI_API_KEY` | Google Gemini API key | Get one from [Google AI Studio](https://aistudio.google.com/apikey) |
| `S3_BUCKET` | Local artifact bucket name | Use `autonoma-local` for the default Docker Compose MinIO setup |
| `S3_REGION` | S3 region | Use `us-east-1` for the default Docker Compose MinIO setup |
| `S3_ACCESS_KEY_ID` | MinIO access key | Use `minioadmin` for the default Docker Compose MinIO setup |
| `S3_SECRET_ACCESS_KEY` | MinIO secret key | Use `minioadmin` for the default Docker Compose MinIO setup |
| `S3_ENDPOINT` | Local MinIO endpoint | Use `http://localhost:9000` for the default Docker Compose MinIO setup |

### How environment variables work in the codebase

The project uses `createEnv` from `@t3-oss/env-core` for environment variable validation. Each app has an `env.ts` file that defines its required variables with Zod schemas. Variables are validated at startup - if something is missing, you get a clear error message telling you exactly what to add.

You should never read `process.env` directly in application code. Instead, import from the app's `env.ts` file.

See `.env.example` for the full list of variables grouped by service. The MinIO-backed storage values in that file match the default local Docker Compose setup.

## Database setup

Generate the Prisma client and run migrations:

```bash
pnpm db:generate
pnpm db:migrate
```

`db:generate` creates the TypeScript client from the Prisma schema. `db:migrate` applies all migrations to create the database tables.

You need to re-run `db:generate` whenever the Prisma schema changes (after pulling new changes or editing the schema yourself).

## Start development servers

```bash
pnpm dev
```

This starts both servers concurrently:

- **UI** at `http://localhost:3000` (Vite + React)
- **API** at `http://localhost:4000` (Hono + tRPC)

To run them individually:

```bash
pnpm api    # API only (port 4000)
pnpm ui     # UI only (port 3000)
```

## Verify everything works

1. Open `http://localhost:3000` in your browser
2. You should see the login page
3. Sign in with Google OAuth
4. If you see the dashboard, everything is working

Run the full check suite to make sure nothing is broken:

```bash
pnpm typecheck    # TypeScript type checking
pnpm lint         # ESLint
pnpm test         # Vitest
pnpm build        # Full build
```

## Other useful commands

| Command | Description |
| --- | --- |
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

## Troubleshooting

### `pnpm install` fails

Make sure you're using pnpm 10.x. Run `corepack enable` to let Node manage the pnpm version, then try again.

### Database connection refused

Check that Docker Compose is running: `docker compose ps`. If PostgreSQL isn't up, check logs with `docker compose logs postgres`.

### Prisma generate fails

This usually means dependencies aren't installed. Run `pnpm install` first, then `pnpm db:generate`.

### Port already in use

Another process is using port 3000 or 4000. Find and kill it:

```bash
lsof -i :3000  # or :4000
kill <PID>
```

### Google OAuth redirect error

Make sure your Google Cloud OAuth credentials have `http://localhost:4000/api/auth/callback/google` as an authorized redirect URI.

### "Missing environment variable" error on startup

The app validates all required environment variables at startup using `createEnv`. Check the error message for which variable is missing, then add it to your `.env` file.

### TypeScript errors after pulling changes

Run `pnpm db:generate` first (the Prisma client may have changed), then `pnpm build` to rebuild all packages. TypeScript errors in the UI or API often come from stale package builds.
