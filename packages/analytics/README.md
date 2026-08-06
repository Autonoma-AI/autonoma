# @autonoma/analytics

Server-side event tracking for Autonoma backend services, built on [PostHog](https://posthog.com/) with automatic Sentry trace linking.

## What it does

Provides a singleton `PostHogAnalytics` instance that wraps `posthog-node`. It automatically enriches every captured event with the active Sentry trace ID (`$sentry_trace_id`), linking analytics events to distributed traces. When not initialized (e.g. in dev/test), all calls are safely no-ops.

## Exports

| Export | Type | Description |
|--------|------|-------------|
| `analytics` | `PostHogAnalytics` | Pre-created singleton instance - use this directly |
| `PostHogAnalytics` | class | The class itself, if you need the type |
| `withPostHogSession` | function | Binds a browser session id to an async scope, so events captured inside it carry `$session_id` |

## Usage

### Initialization

Call `init()` once at app startup. Typically done in the API entrypoint:

```ts
import { analytics } from "@autonoma/analytics";

if (env.POSTHOG_KEY != null) {
    analytics.init(env.POSTHOG_KEY, env.POSTHOG_HOST);
}
```

### Capturing events

```ts
import { analytics } from "@autonoma/analytics";

analytics.capture(userId, "test_generation.completed", {
    generationId,
    applicationId,
    status: "success",
});
```

- `distinctId` - always an explicit user ID (from auth context or job payload)
- `event` - dot-separated event name (e.g. `"test_run.started"`)
- `properties` - optional key-value metadata
- `groups` - optional PostHog group analytics mapping (`{ groupType: groupKey }`), so an event can be attributed to a customer/organization, not just a user

If a Sentry span is active when `capture()` is called, the trace ID is automatically attached as `$sentry_trace_id`.

To break usage down per customer, pass the `groups` argument with the organization group:

```ts
analytics.capture(userId, "mcp.tool_called", { tool, success }, { organization: organizationId });
```

### Linking events to a session recording

An event captured while serving a browser request should resolve to that user's session replay - the difference between knowing a step failed and being able to watch someone hit it. The API binds the session for the whole request, so no call site passes it:

```ts
import { withPostHogSession } from "@autonoma/analytics";

// apps/api/src/app.ts - the browser sends POSTHOG_SESSION_HEADER on every tRPC call
app.use("*", (c, next) => withPostHogSession(c.req.header(POSTHOG_SESSION_HEADER), next));
```

Everything captured inside that scope, at any depth, gains `$session_id`. A request with no session (a job, a Vercel machine-to-machine callback, curl) runs unbound and its events simply carry none - so wrapping unconditionally is safe.

The id is read from ambient scope rather than threaded through call signatures, matching how `$sentry_trace_id` already works. It is deliberately *not* part of the canonical observability context: that schema is for Autonoma's own domain IDs, while this is a vendor transport detail only the analytics client reads.

The CLI does the same thing with its own run id (`apps/cli/src/core/analytics.ts`), so a run's recording, events and logs all resolve to one another.

### Shutdown

Flush pending events on process exit:

```ts
await analytics.shutdown();
```

## Architecture notes

- The singleton pattern means you import and use `analytics` anywhere - no dependency injection needed.
- If `init()` is never called, the internal PostHog client stays `undefined` and all `capture()` calls silently do nothing. This keeps dev and test environments clean without conditional logic at call sites.
- Sentry integration uses `@sentry/node` to read the active span and extract the trace ID - no extra configuration required beyond having Sentry initialized.
- The session scope is an `AsyncLocalStorage` rather than a module variable because the API serves requests concurrently: a leak would attribute one customer's server-side events to another customer's session recording. That isolation is what `posthog-session.test.ts` covers.
