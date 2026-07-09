# Jobs

Background jobs that run as standalone processes, orchestrated as Temporal activities executed by workers. Each subdirectory is a separate job with its own Dockerfile and entry point.

## Job Index

| Job | Package Name | Purpose |
|-----|-------------|---------|
| **run-completion-notification** | `@autonoma/job-run-completion-notification` | Sends notifications when a run completes. |
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

For local diffs tooling - analysis, the full pipeline, and generation reviewer inspection - see `@autonoma/worker-diffs` (e.g. `pnpm --filter @autonoma/worker-diffs diffs-agent`, `full-pipeline`, `review:generation <generationId>`).

## Environment Variables

All jobs use `createEnv` from `@t3-oss/env-core` for validated environment configuration.

### Shared (Logger) - inherited by most jobs

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | No | `development`, `production`, or `test` (default: `development`) |
| `SENTRY_DSN` | No | Sentry DSN for error tracking |
| `SENTRY_ENV` | No | Sentry environment tag (default: `production`) |
| `SENTRY_RELEASE` | No | Sentry release identifier (default: `unknown`) |

## Architecture Notes

- **Each job is a separate Docker image.** Jobs never share images. They share logic through workspace packages (`@autonoma/ai`, `@autonoma/db`, `@autonoma/diffs`, etc.).
- **Run-once semantics.** Jobs execute a `main()` function wrapped in `runWithSentry()` and exit. They are not long-running services.
- **Error handling follows the `fx` pattern** from `@autonoma/try` - Go-style error tuples with `fx.runAsync` / `fx.run`.
