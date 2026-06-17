# Jobs

Background jobs that run as standalone processes, orchestrated as Temporal activities executed by workers. Each subdirectory is a separate job with its own Dockerfile and entry point.

## Job Index

| Job | Package Name | Purpose |
|-----|-------------|---------|
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

For local diffs tooling - analysis, the full pipeline, and generation/replay reviewer inspection - see `@autonoma/worker-diffs` (e.g. `pnpm --filter @autonoma/worker-diffs diffs-agent`, `full-pipeline`, `review:generation <generationId>`, `review:replay <runId>`).

## Environment Variables

All jobs use `createEnv` from `@t3-oss/env-core` for validated environment configuration.

### Shared (Logger) - inherited by most jobs

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | No | `development`, `production`, or `test` (default: `development`) |
| `SENTRY_DSN` | No | Sentry DSN for error tracking |
| `SENTRY_ENV` | No | Sentry environment tag (default: `production`) |
| `SENTRY_RELEASE` | No | Sentry release identifier (default: `unknown`) |

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
