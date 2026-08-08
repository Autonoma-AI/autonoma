---
title: Development Setup
description: How to get Autonoma AI running locally - from prerequisites through a working dev environment.
---

## Prerequisites

You need three things installed before starting:

| Tool | Version | How to get it |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | >= 24 | Use [nvm](https://github.com/nvm-sh/nvm) or download directly |
| [pnpm](https://pnpm.io/) | 11.x | Run `corepack enable` - the version is pinned in `package.json` |
| [Docker](https://www.docker.com/) | Latest | Docker Desktop or Docker Engine |

**Optional tools** (only needed if you're working on specific engines):

- [Playwright](https://playwright.dev/) - for `engine-web` development
- [Appium](https://appium.io/) - for `engine-mobile` development

## Clone and install

```bash
git clone https://github.com/autonoma-ai/autonoma.git
cd agent
pnpm install
```

`pnpm install` handles the entire monorepo - all apps and packages get their dependencies in one pass.

## Start infrastructure

PostgreSQL and Redis run via Docker Compose:

```bash
docker compose up -d
```

This starts:

- **PostgreSQL 18** on `localhost:5432` (user: `postgres`, password: `postgres`)
- **Redis** on `localhost:6379`

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
| `BETTER_AUTH_URL` | The API's own address - where `/v1/auth/*` is reachable | `http://localhost:4000` for local dev. Better-auth uses this (not `APP_URL`) as `baseURL`, so it's what OAuth providers redirect back to. |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | Create OAuth credentials in the [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Set the authorized redirect URI to `http://localhost:4000/v1/auth/callback/google` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | Same Google Cloud Console OAuth credentials page |
| `GEMINI_API_KEY` | Google Gemini API key | Get one from [Google AI Studio](https://aistudio.google.com/apikey) |

### Optional: GitHub sign-in

The login page offers Google and GitHub. GitHub is optional - the API only registers the provider when both variables below are set, so leaving them empty gives you a Google-only login.

| Variable | Description | Where to get it |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID | Create an OAuth app at [github.com/settings/developers](https://github.com/settings/developers). Set the authorization callback URL to `http://localhost:4000/v1/auth/callback/github` |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret | Generate one on the same OAuth app page - GitHub shows it only once |

To create the OAuth app:

1. Go to **Settings -> Developer settings -> OAuth Apps -> New OAuth App** on GitHub.
2. **Application name**: anything you'll recognize, e.g. `Autonoma (local)`.
3. **Homepage URL**: `http://localhost:3000` (the UI).
4. **Authorization callback URL**: `http://localhost:4000/v1/auth/callback/github` (the API - better-auth serves the callback, not the UI).
5. Register the app, copy the client ID, then **Generate a new client secret** and copy that too.
6. Put both in `.env` as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and restart the API.

:::caution
These are not the `GITHUB_APP_*` variables. Those belong to the separate GitHub App that reads repositories and posts PR checks. Sign-in uses an OAuth app, which is a different thing you create on the same settings page.
:::

Signing in with GitHub against an email that already has a Google account links the two, so you land in the same account either way. Linking requires both emails to be verified - GitHub sign-in with an unverified GitHub email lands back on the login page with an error.

### How environment variables work in the codebase

The project uses `createEnv` from `@t3-oss/env-core` for environment variable validation. Each app has an `env.ts` file that defines its required variables with Zod schemas. Variables are validated at startup - if something is missing, you get a clear error message telling you exactly what to add.

You should never read `process.env` directly in application code. Instead, import from the app's `env.ts` file.

See `.env.example` for the full list of variables grouped by service. Most optional variables have sensible defaults or are only needed for specific features (S3 storage, Sentry, PostHog, etc.).

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
3. Sign in with Google (or GitHub, if you configured an OAuth app for it)
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

Make sure you're using pnpm 11.x. Run `corepack enable` to let Node manage the pnpm version, then try again.

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

Make sure your Google Cloud OAuth credentials have `http://localhost:4000/v1/auth/callback/google` as an authorized redirect URI - better-auth uses `BETTER_AUTH_URL` (the API's own address) as `baseURL`, so that's what it sends Google as the `redirect_uri`, not the UI's origin.

### GitHub OAuth redirect error

Same cause as the Google one: the authorization callback URL on your GitHub OAuth app must be `http://localhost:4000/v1/auth/callback/github` (the API's address from `BETTER_AUTH_URL`), not the UI's origin. GitHub rejects a mismatch with `redirect_uri is not associated with this application`.

If the GitHub button sends you straight back to `/login` with a "Sign in failed" toast, check the API logs - a boot log line reading `GitHub OAuth credentials not configured` means `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` is missing, so the provider was never registered.

### `Failed to decrypt private key` error from Better Auth

The API's JWKS keypair (`jwks` table) is encrypted with `BETTER_AUTH_SECRET`. If that row was created under a different secret than the one currently in your `.env` - for example after regenerating `BETTER_AUTH_SECRET`, since Docker Compose keeps Postgres data in a persistent volume across restarts - decryption fails once, then self-heals (Better Auth regenerates the keypair under the current secret on the next request). If you'd rather not wait for that, clear the stale row yourself:

```bash
psql $DATABASE_URL -c "TRUNCATE TABLE jwks;"
```

### "Missing environment variable" error on startup

The app validates all required environment variables at startup using `createEnv`. Check the error message for which variable is missing, then add it to your `.env` file.

### TypeScript errors after pulling changes

Run `pnpm db:generate` first (the Prisma client may have changed), then `pnpm build` to rebuild all packages. TypeScript errors in the UI or API often come from stale package builds.
