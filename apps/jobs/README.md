# Jobs

Background jobs that run as standalone processes, orchestrated as Temporal activities executed by workers. Each subdirectory is a separate job with its own Dockerfile and entry point.

## Job Index

| Job | Package Name | Purpose |
|-----|-------------|---------|
| **diffs** | `@autonoma/job-diffs` | Analyzes code diffs on a branch, runs an AI agent to determine test impacts (new tests, updates, bug reports), and queues pending generations. |
| **scenario** | `@autonoma/job-scenario` | Manages test scenario lifecycle - "up" provisions a scenario instance before a run/generation, "down" tears it down afterward. |
| **reviewer** | (legacy) | Build artifact only - no source files. Reviewer logic now lives in `@autonoma/diffs`; production review runs as a Temporal activity in `apps/workers/general`. |
| **notifier** | (legacy) | Build artifact only - no source files. Previously handled SNS/SQS notifications. |

## Tech Stack

- **Runtime:** Node.js 24 (ESM-only)
- **Language:** TypeScript (strictest config)
- **Build:** tsup
- **AI:** Vercel AI SDK + Gemini (via `@autonoma/ai`)
- **Database:** Prisma (`@autonoma/db`)
- **Storage:** S3 (`@autonoma/storage`)
- **Logging/Monitoring:** Sentry (`@autonoma/logger`)
- **Env Validation:** `@t3-oss/env-core` with Zod schemas
- **GitHub Integration:** Octokit (`@octokit/app`, `@octokit/rest`)

## Running Jobs

### Build

```bash
# Build all jobs (from monorepo root)
pnpm build

# Build a specific job
cd apps/jobs/<job-name>
pnpm build
```

### Run Locally

Jobs that support local execution have a dedicated script:

```bash
# scenario (test mode)
cd apps/jobs/scenario
pnpm test:scenario  # runs: tsx --env-file=../../../.env src/test-scenario.ts
```

For local generation/replay reviewer inspection, see `@autonoma/worker-diffs` (`pnpm --filter @autonoma/worker-diffs review:generation <generationId>` / `review:replay <runId>`).

## Environment Variables

All jobs use `createEnv` from `@t3-oss/env-core` for validated environment configuration.

### Shared (Logger) - inherited by most jobs

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | No | `development`, `production`, or `test` (default: `development`) |
| `SENTRY_DSN` | No | Sentry DSN for error tracking |
| `SENTRY_ENV` | No | Sentry environment tag (default: `production`) |
| `SENTRY_RELEASE` | No | Sentry release identifier (default: `unknown`) |

### Shared (AI) - used by diffs

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_KEY` | Yes | Groq API key |
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key |

### Shared (Storage) - used by diffs

| Variable | Required | Description |
|----------|----------|-------------|
| `S3_BUCKET` | Yes | S3 bucket name |
| `S3_REGION` | Yes | S3 region |
| `S3_ACCESS_KEY_ID` | Yes | S3 access key |
| `S3_SECRET_ACCESS_KEY` | Yes | S3 secret key |

### diffs

| Variable | Required | Description |
|----------|----------|-------------|
| `BRANCH_ID` | Yes | Branch to analyze |
| `GITHUB_APP_ID` | Yes | GitHub App ID for repo access |
| `GITHUB_APP_PRIVATE_KEY` | Yes | GitHub App private key, base64-encoded PEM |
| `GITHUB_APP_WEBHOOK_SECRET` | Yes | GitHub App webhook secret |
| `AGENT_VERSION` | No | Agent version tag (default: `latest`) |

### scenario

| Variable | Required | Description |
|----------|----------|-------------|
| `SCENARIO_ENCRYPTION_KEY` | Yes | Key for encrypting/decrypting scenario credentials |
| `SCENARIO_JOB_TYPE` | Yes (up) | `"run"` or `"generation"` |
| `ENTITY_ID` | Yes (up) | ID of the run or generation entity |
| `SCENARIO_INSTANCE_ID` | Yes (down) | ID of the scenario instance to tear down |

## Architecture Notes

- **Each job is a separate Docker image.** Jobs never share images. They share logic through workspace packages (`@autonoma/ai`, `@autonoma/db`, `@autonoma/diffs`, etc.).
- **Run-once semantics.** Jobs execute a `main()` function wrapped in `runWithSentry()` and exit. They are not long-running services.
- **Error handling follows the `fx` pattern** from `@autonoma/try` - Go-style error tuples with `fx.runAsync` / `fx.run`.
- **Scenario job has two entry points:** `up.ts` (provision before test) and `down.ts` (teardown after test), each with their own env validation.
