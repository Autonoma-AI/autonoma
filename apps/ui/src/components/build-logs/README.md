# Build log stream (reference component)

An isolated, drop-in example for consuming the previewkit **live build-log SSE
stream**. Lift it into a real page (e.g. a deployment detail view) or use it as a
pattern. Nothing here touches routing or the tRPC layer.

## Files

| File | Role |
|------|------|
| `use-build-log-stream.ts` | The reusable core - subscribes via `@microsoft/fetch-event-source` (so it can send an `Authorization` header) and accumulates entries. Transport-only; takes a `url` + optional `headers`. |
| `build-log-stream-viewer.tsx` | Presentational terminal-style viewer + `PreviewBuildLogStreamExample` (builds the URL from owner/repo/pr + a bearer token). |
| `preview-logs-tabs.tsx` | `PreviewLogsTabs` - build vs. runtime (`?source=app`) tab pair with a debounced server-side search box. Scoped to one app via the `app` prop. |
| `log-app-filter.tsx` | `LogAppFilter` - segmented app/service selector that drives `PreviewLogsTabs`' `app` prop (one app is always selected). Shared by the admin PreviewKit page and the onboarding deploy step. |

## Usage

```tsx
import { PreviewBuildLogStreamExample } from "components/build-logs/build-log-stream-viewer";

<PreviewBuildLogStreamExample owner="acme" repo="api" pr={42} accessToken={token} />;
```

Or drive the pieces directly:

```tsx
import { BuildLogStreamViewer, buildPreviewLogStreamUrl } from "components/build-logs/build-log-stream-viewer";
import { useBuildLogStream } from "components/build-logs/use-build-log-stream";

// Whole viewer:
<BuildLogStreamViewer
  url={buildPreviewLogStreamUrl("acme", "api", 42)}
  headers={{ Authorization: `Bearer ${token}` }}
  className="max-w-3xl"
/>;

// Just the data, your own UI:
const { entries, phase, buildStatus, connection, error } = useBuildLogStream({ url, headers });
```

## Server contract

Endpoint: `GET /v1/previewkit/environments/:owner/:repo/:pr/logs/stream` (SSE).

Named events (`event:` field):

| Event | `data` | Meaning |
|-------|--------|---------|
| `log` | JSON `{ kind, app?, message }` | A chunk of build output. |
| `phase` | JSON `{ kind, message }` | Pipeline phase change (`cloning`, `building-images`, ...). |
| `status` | JSON `{ kind, message }` | Terminal build status (`ready` / `failed`). |
| `done` | status string | Stream finished; the client closes. |
| `error` | message string | Server gave up on the stream; the client closes. |
| `heartbeat` | (empty) | Keep-alive only; ignored. |

Each `log`/`phase`/`status` event carries an `id:` (the Redis Stream entry id).
On reconnect the transport sends it back as `Last-Event-Id` and the server
resumes from that cursor - so transient drops self-heal with no gaps and no
manual retry.

When a build is already finished (or its stream has expired), prefer the
permanent S3 build-log link from the environment status instead of streaming.

## Auth

The stream route accepts **either** a logged-in app session cookie **or** an API
key / service secret. So in-app you need **no token**: the hook sends
`credentials: "include"`, and the session cookie authenticates you. Cross-origin
preview environments work too - the API sends matching CORS headers.

- **In-app (recommended):** just render the viewer; the session cookie is used.
  `<PreviewBuildLogStreamExample owner repo pr />` - omit `accessToken`.
- **Programmatic / non-session callers:** pass a per-user API key or a
  short-lived token as `accessToken` / `headers.Authorization`. The transport is
  `@microsoft/fetch-event-source` precisely so it can send that header; don't
  ship a broad, long-lived key to the browser.

Because the hook is transport-only (URL + headers in), switching strategies never
touches the rendering code.
