# @autonoma/logger

Structured logging package for all Autonoma backend services. Wraps Sentry for production error tracking and provides colorized console output for local development.

## Exports

| Export | Description |
|--------|-------------|
| `logger` | Root logger singleton (`rootLogger`) - the primary entry point for logging |
| `Logger` | Type alias for `SentryLogger` - use in function signatures accepting a logger |
| `createSentryConfig` | Builds a `@sentry/node` `NodeOptions` config from a scope config |
| `runWithSentry` | Initializes Sentry + runs an async job with proper flush and exit handling |
| `RunWithSentryOptions` | Options type for `runWithSentry` |
| `ObservabilityContext` | Typed interface listing every canonical log/observability field name |
| `ObservabilityContextSchema` | Zod schema that backs `ObservabilityContext` - source of truth for what's canonical |
| `withObservabilityContext` | Bind a set of canonical IDs to the current async scope (AsyncLocalStorage) |
| `getObservabilityContext` | Read the currently-bound canonical IDs |
| `extendObservabilityContext` | Merge additional fields into the current scope (no-op outside one) |
| `pickObservabilityContext` | Zod-validate and pick canonical fields off an unknown shape |
| `OBSERVABILITY_CONTEXT_KEYS` | Tuple of every canonical field name |
| `LogExtra` | Payload type for `logger.{info,warn,error,debug}` calls (canonical fields + `extra`) |

A secondary export path `@autonoma/logger/env` exposes the validated environment config.

## Usage

### Root logger

```ts
import { logger } from "@autonoma/logger";

logger.info("Server started", { port: 4000 });
logger.error("Request failed", new Error("timeout"), { route: "/api/test" });
logger.warn("Slow query", { duration: 1200 });
logger.debug("Cache hit", { key: "user:123" });
```

### Child loggers (classes)

Every class should create a child logger with its name and identifying context. Child loggers inherit all parent bindings and propagate them into Sentry scope/extras.

```ts
import { type Logger, logger } from "@autonoma/logger";

class TestRunner {
    private readonly logger: Logger;

    constructor(private readonly runId: string) {
        this.logger = logger.child({ name: this.constructor.name, runId });
    }

    run() {
        this.logger.info("Starting test run");
        // logs include { name: "TestRunner", runId: "..." } automatically
    }
}
```

### Accepting a logger parameter

Reusable functions called from classes should accept a `Logger` parameter to preserve the caller's context chain.

```ts
import type { Logger } from "@autonoma/logger";

function processResult(result: Result, logger: Logger) {
    logger.info("Processing result", { status: result.status });
}
```

### Running a job with Sentry

`runWithSentry` initializes Sentry, executes the provided async function, flushes events, and calls `process.exit`. Use this as the entry point for K8s jobs.

```ts
import { logger, runWithSentry } from "@autonoma/logger";

await runWithSentry({ name: "my-job", tags: { queue: "default" } }, async () => {
    logger.info("Job started");
    // ... do work ...
});
```

### Sentry config for long-running services

For services (API server, engines), initialize Sentry manually with `createSentryConfig`:

```ts
import * as Sentry from "@sentry/node";
import { createSentryConfig } from "@autonoma/logger";

Sentry.init(createSentryConfig({
    contextType: "api-server",
    contextName: "api",
    tags: { service: "api" },
}));
```

## Canonical observability context

Every log line, Sentry tag, and PostHog event property emitted from the backend
should carry the same set of camelCase IDs. The canonical schema lives in
`observability-context.ts` and is the only place where field names are added or
renamed.

### Rules

- All canonical IDs are **camelCase**. No `snake_case`.
- Fields live inside atomic **groups** (`temporal`, `organization`, `application`,
  `branch`, `snapshot`, `refinementLoop`, `refinementIteration`, `testCase`,
  `testGeneration`, `run`, `job`). Each group is optional, but if you include a
  group, all of its required fields must be present. You can't have a workflow
  context with `workflowId` but no `temporalRunId`.
- One concept, one name. Never both `runId` and `run_id`; never both
  `iteration` and `iterationNumber`.
- Add a field to a group in `ObservabilityContextSchema` before using it. Don't
  invent new keys at call sites.
- Anything that is not a canonical ID goes under `extra:` in the log payload.

Internally the context is **stored nested** (groups in ALS) and **emitted
flat** (single-level keys on Sentry tags / log records / PostHog properties),
so consumers downstream still see `snapshotId`, `branchId`, `workflowId` as
top-level keys.

### Ambient context with AsyncLocalStorage

Wrap an entry point (Temporal activity, job, request handler) in
`withObservabilityContext({ ... })` once. Every `logger.*` call inside that
scope automatically gets those fields - including from deeply nested functions,
across `await` boundaries, and from `child()` loggers.

```ts
import { logger, withObservabilityContext, extendObservabilityContext } from "@autonoma/logger";

await withObservabilityContext(
    { snapshot: { snapshotId }, job: { jobName: "diffs" } },
    async () => {
        logger.info("Starting diffs analysis"); // emits snapshotId + jobName

        const branchId = await loadBranchId(snapshotId);
        extendObservabilityContext({ branch: { branchId } }); // adds branchId

        logger.info("Branch loaded"); // emits snapshotId + jobName + branchId
    },
);
```

### Temporal integration

Workers built with `@autonoma/workflow/worker` install an activity interceptor
that:

1. Sets the canonical Temporal IDs (`workflowId`, `temporalRunId`,
   `workflowType`, `taskQueue`, `activityType`, `activityId`, `attempt`).
2. Calls `loadSnapshotObservabilityContext(snapshotId)` if the activity input
   has a `snapshotId`, to derive `branchId`, `applicationId`, `organizationId`,
   `headSha`, `baseSha`, `prevSnapshotId`, `prNumber` in one Prisma query.
3. Picks up any other canonical ID present directly on the activity input
   (`iterationId`, `loopId`, `testGenerationId`, `runId`, ...).

After that, an activity body can just do `logger.info("did the thing")` and
every relevant ID shows up in the log, in Sentry tags, and in any PostHog
event captured during the activity.

For workflow code (which can't use ALS or Prisma), use the raw `log` from
`@temporalio/workflow` and pass canonical IDs as the meta arg. The worker
installs `temporalSdkLogger` (`packages/workflow/src/worker/temporal-sdk-logger.ts`)
on the Temporal Runtime, which forwards every workflow log call to
`BackendLogger` -> Sentry + PostHog + console. Temporal also auto-injects
`workflowId`, `runId` (remapped to `temporalRunId`), `taskQueue`, and
`workflowType`, so the only thing the workflow needs to add is the domain IDs.

```ts
import { log } from "@temporalio/workflow";

export async function myWorkflow(input) {
    log.info("Workflow started", { snapshot: { snapshotId: input.snapshotId } });
    // Sentry event includes: snapshotId, workflowId, temporalRunId, taskQueue, workflowType
}
```

### Don't pass IDs by hand

```ts
// BAD - ambient context already provides snapshotId/branchId/applicationId
logger.child({ name: "AnalyzeDiffs", snapshotId, branchId, applicationId }).info("starting");

// GOOD - name binds the class, IDs come from the ambient context
logger.child({ name: "AnalyzeDiffs" }).info("starting");
```

```ts
// BAD - ad-hoc fields at the top level pollute the canonical namespace
logger.info("Generation queue prepared", { count: prepared.length });

// GOOD - extra: bag for anything non-canonical
logger.info("Generation queue prepared", { extra: { count: prepared.length } });
```

## Log levels

| Method | When to use |
|--------|-------------|
| `debug` | Verbose details - only printed when `DEBUG=true` or outside production |
| `info` | Normal operational events |
| `warn` | Unexpected but recoverable situations |
| `error` | Failures with optional `Error` object as second argument |
| `fatal` | Unrecoverable errors - also captured as Sentry exceptions |
| `captureError` | Directly capture an error to Sentry with optional severity |

## Architecture

### Dual-mode output

- **Production** (`NODE_ENV=production`): logs are sent to Sentry via `@sentry/node` logger and also printed in plain text to stdout/stderr.
- **Development**: logs are pretty-printed with ANSI colors and timestamps. Sentry calls are skipped entirely (no DSN configured).

### Class hierarchy

- `ConsoleLogger` - low-level structured console output with `child()` support and colorized formatting.
- `SentryLogger` (abstract) - adds Sentry integration, execution mode tracking, user context, and convenience methods (`info`, `error`, `warn`, etc.).
- `BackendLogger` (concrete) - implements all abstract Sentry methods. Merges bindings into Sentry scope extras and console output.

### Root logger proxy

`rootLogger` is a lazy proxy object that delegates to a `BackendLogger` singleton. This avoids import-order issues - the instance is created on first access.

### Environment variables

Validated with `@t3-oss/env-core` + Zod in `env.ts`:

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Controls Sentry activation and log formatting |
| `SENTRY_DSN` | - | Sentry project DSN (required in production) |
| `SENTRY_ENV` | `production` | Sentry environment tag |
| `SENTRY_RELEASE` | `unknown` | Release version for Sentry |
| `DEBUG` | - | Set to `"true"` to enable debug logs in production |
