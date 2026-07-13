# @autonoma/logger

Structured logging package for all Autonoma backend services. Wraps Sentry for production error tracking and provides colorized console output for local development.

## Exports

| Export                       | Description                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `logger`                     | Root logger singleton (`rootLogger`) - the primary entry point for logging           |
| `Logger`                     | Type alias for `SentryLogger` - use in function signatures accepting a logger        |
| `createSentryConfig`         | Builds a `@sentry/node` `NodeOptions` config from a scope config                     |
| `runWithSentry`              | Initializes Sentry + runs an async job with proper flush and exit handling           |
| `RunWithSentryOptions`       | Options type for `runWithSentry`                                                     |
| `ObservabilityContext`       | Typed interface listing every canonical log/observability field name                 |
| `ObservabilityContextSchema` | Zod schema that backs `ObservabilityContext` - source of truth for what's canonical  |
| `withObservabilityContext`   | Bind a set of canonical IDs to the current async scope (AsyncLocalStorage)           |
| `getObservabilityContext`    | Read the currently-bound canonical IDs                                               |
| `extendObservabilityContext` | Merge additional fields into the current scope (no-op outside one)                   |
| `pickObservabilityContext`   | Zod-validate and pick canonical fields off an unknown shape                          |
| `OBSERVABILITY_CONTEXT_KEYS` | Tuple of every canonical field name                                                  |
| `LogExtra`                   | Payload type for `logger.{info,warn,error,debug}` calls (canonical fields + `extra`) |

Secondary export paths:

- `@autonoma/logger/env` exposes the validated environment config.
- `@autonoma/logger/loki-build-log-sink` exposes `LokiBuildLogSink` for PreviewKit build-log publishing.
- `@autonoma/logger/loki-log-store` exposes `LokiLogStore` for PreviewKit build/app log reads.

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

### PreviewKit log relay

PreviewKit build and app logs use Grafana Loki as the customer-facing log data plane. Build output is pushed through `LokiBuildLogSink`, app stdout/stderr is collected by the preview cluster logging stack, and the API reads both sources with `LokiLogStore` before relaying entries to the browser over SSE.

All of a PR's logs share one append-only Loki stream per source (keyed by `namespace`, which is stable per PR), so both sources scope a fresh viewer to the latest run with a `kind="start"` sentinel:

- **Build:** each build attempt calls `LokiBuildLogSink.markStart` at its start (pushed with `source="build"`). A fresh build-source viewer replays only from the latest marker, so a rerun's output overwrites prior attempts.
- **App:** each deployment calls `LokiBuildLogSink.markDeploymentStart` as the new app pods roll out (pushed with `source="app"`). A fresh app-source viewer replays forward from the latest marker, so a redeploy's runtime output supersedes the prior deployment's lines.

In both cases `LokiLogStore` falls back to the per-source window default when no marker exists (build: full retention replay; app: tail the newest lines), and the markers themselves are excluded from the relayed timeline. Reconnects resume from a real nanosecond cursor, so they are unaffected.

`readBatch` also accepts an optional `filter` - a case-insensitive substring search applied as a Loki line filter (`|~`), so the viewer searches the whole retained stream server-side rather than only the lines already buffered in the browser. The API surfaces it as `?filter=` on the SSE route and the app/build log tabs render a search box for it. The term is untrusted, so it is escaped (regex metacharacters are made literal) and embedded in Loki's double-quoted string form, which cannot be broken out of. The filter is applied only to the line query, never to the `kind="start"` marker lookup, so the replay floor is always resolved even when the search matches nothing.

The sink also emits a non-display `kind="finish"` telemetry marker via `LokiBuildLogSink.markFinished` at the end of each successful build. It is labeled `{namespace, source="build", kind="finish", app, builder}` (`builder` is `ephemeral` for the isolated per-build buildkitd Job path) with `{ durationMs, host }` in the line body, and is excluded from the viewer (like `start`). Build-speed dashboards aggregate it with `{source="build", kind="finish", app=~"$app", builder=~"$builder"} | json | unwrap durationMs`, grouping/filtering by the `app`, `builder`, and `namespace` labels.

This path is intentionally separate from telemetry logging: customer build output may echo secrets, so it must not flow into Sentry. The sink only uses the root logger to observe delivery failures.

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

Sentry.init(
    createSentryConfig({
        contextType: "api-server",
        contextName: "api",
        tags: { service: "api" },
    }),
);
```

Pass an optional `beforeSend` to drop service-specific noise. It runs only after the
shared filters (dev short-circuit, `ChunkLoadError`, `AbortError`) let the event
through; return the event to keep it or `null` to drop it. The API uses this to drop
expected client-error tRPC responses (4xx) so they don't page on-call:

```ts
Sentry.init(
    createSentryConfig({
        contextType: "service",
        contextName: "api",
        beforeSend: dropExpectedClientErrors,
    }),
);
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

await withObservabilityContext({ snapshot: { snapshotId }, job: { jobName: "diffs" } }, async () => {
    logger.info("Starting diffs analysis"); // emits snapshotId + jobName

    const branchId = await loadBranchId(snapshotId);
    extendObservabilityContext({ branch: { branchId } }); // adds branchId

    logger.info("Branch loaded"); // emits snapshotId + jobName + branchId
});
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

| Method         | When to use                                                            |
| -------------- | ---------------------------------------------------------------------- |
| `debug`        | Verbose details - only printed when `DEBUG=true` or outside production |
| `info`         | Normal operational events                                              |
| `warn`         | Unexpected but recoverable situations                                  |
| `error`        | Failures with optional `Error` object as second argument               |
| `fatal`        | Unrecoverable errors - also captured as Sentry exceptions              |
| `captureError` | Directly capture an error to Sentry with optional severity             |

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

| Variable         | Default       | Description                                        |
| ---------------- | ------------- | -------------------------------------------------- |
| `NODE_ENV`       | `development` | Controls Sentry activation and log formatting      |
| `SENTRY_DSN`     | -             | Sentry project DSN (required in production)        |
| `SENTRY_ENV`     | `production`  | Sentry environment tag                             |
| `SENTRY_RELEASE` | `unknown`     | Release version for Sentry                         |
| `DEBUG`          | -             | Set to `"true"` to enable debug logs in production |
