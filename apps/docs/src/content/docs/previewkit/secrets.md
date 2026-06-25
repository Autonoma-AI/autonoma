---
title: Secrets
description: How to manage credentials, API keys, and other sensitive values for your Previewkit environments.
---

Anything you wouldn't commit to your repo - API keys, database URLs, signed tokens - should not live in your stack configuration. Manage it through the autonoma API instead. Every key you upload is mounted into your running app as an environment variable; your code just reads `process.env.STRIPE_API_KEY` and gets the value.

## Managing secrets

```
GET    /v1/previewkit/secrets/:applicationId/:app                # list keys (no values)
PUT    /v1/previewkit/secrets/:applicationId/:app                # batch upsert; body: {"items":[{"key","value"},...]}
PUT    /v1/previewkit/secrets/:applicationId/:app/:key           # single upsert; body: {"value":"..."}
DELETE /v1/previewkit/secrets/:applicationId/:app/:key           # delete one key
```

`applicationId` is your autonoma Application row id. Look it up once via the dashboard and hardcode it in your CI. `app` matches an app's `name` in your stack configuration. For a single-app repo it's just that one name; for a monorepo each app has its own bundle.

### Authentication

Every call needs an `Authorization: Bearer <api-key>` header. Create an API key from the autonoma dashboard (Settings → API keys); keys are scoped to your organization, so they can only see and modify your own applications' secrets. Treat them like a password.

```bash
export AUTONOMA_API_KEY="ak_live_..."

# Batch upsert
curl -X PUT "https://api.autonoma.app/v1/previewkit/secrets/app_abc123/web" \
  -H "Authorization: Bearer $AUTONOMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"key":"STRIPE_API_KEY","value":"sk_live_..."},{"key":"SENTRY_DSN","value":"https://..."}]}'

# Single key upsert
curl -X PUT "https://api.autonoma.app/v1/previewkit/secrets/app_abc123/web/STRIPE_API_KEY" \
  -H "Authorization: Bearer $AUTONOMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value":"sk_live_..."}'

# List keys (names only, never values)
curl "https://api.autonoma.app/v1/previewkit/secrets/app_abc123/web" \
  -H "Authorization: Bearer $AUTONOMA_API_KEY"

# Delete
curl -X DELETE "https://api.autonoma.app/v1/previewkit/secrets/app_abc123/web/STRIPE_API_KEY" \
  -H "Authorization: Bearer $AUTONOMA_API_KEY"
```

Calls without a valid Bearer token get a 401. Calls referencing an `applicationId` your key doesn't have access to are indistinguishable from "no secrets yet" - the API never reveals whether a foreign application exists.

Updates take effect on the next preview deploy for that app.

## Build-time secrets (`build_secrets`)

`NEXT_PUBLIC_*` values for Next.js, `VITE_*` values for Vite, anything else baked into a client bundle at compile time - these need to be present during `next build` / `vite build`, not just at runtime. List them in an app's `build_secrets` and Previewkit will pass them to your builder:

```yaml
apps:
  - name: web
    port: 3000
    build_secrets:
      - NEXT_PUBLIC_FIREBASE_API_KEY
      - NEXT_PUBLIC_FIREBASE_PROJECT_ID
      - NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
```

Each name must already be a key you've uploaded via the API. The build fails fast with a clear error if a listed key isn't there.

Server-only secrets (those your running pod reads via `process.env`) do NOT need to be in `build_secrets` - the runtime mount already covers them. Listing them anyway is harmless but verbose.

## Config-level overrides

If you also define a key in an app's `env` map in your stack configuration, the value there wins over the uploaded one. Use this for behaviour switches you want pinned alongside the rest of the config:

```yaml
apps:
  - name: api
    port: 4000
    env:
      # Pin a preview to safe defaults so it can't talk to live services.
      PLAID_ENV: "sandbox"
      SEND_EMAILS_LOCALLY: "false"
```

Template substitutions (`{{api.host}}`, `{{pr}}`, etc.) inside `env` resolve the same way.

## Built-in environment variables

Previewkit injects a few variables into every preview app automatically. You don't upload them, and you can't override them - the names are reserved, so the API rejects any secret you try to set with one of these keys.

| Variable | Value | Notes |
|---|---|---|
| `AUTONOMA_PREVIEWKIT` | `true` | Always set inside a preview. Use it to detect the environment. |
| `AUTONOMA_PREVIEWKIT_PR` | `123` | The pull request number this preview was built from. |
| `AUTONOMA_PREVIEWKIT_URL` | `https://<code>.preview.autonoma.app` | The public HTTPS URL of this app in the preview. In a multi-app preview, each app gets its own URL. |

A common use is tagging your error reporter so preview errors are grouped per PR:

```ts
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // "pr-123" in a preview, "production" everywhere else.
  environment: process.env.AUTONOMA_PREVIEWKIT_PR != null
    ? `pr-${process.env.AUTONOMA_PREVIEWKIT_PR}`
    : "production",
});
```

## What goes where

| Value type | Where it lives |
|---|---|
| Third-party API keys, database URLs, signed tokens | Previewkit API |
| `NEXT_PUBLIC_*` / `VITE_*` baked into a client bundle | Previewkit API, also listed in `build_secrets` |
| In-cluster service URLs (`{{db.host}}`, `{{api.host}}`) | Stack config `env` - resolved automatically, no upload needed |
| PR / owner / namespace metadata (`{{pr}}`, `{{owner}}`, `{{namespace}}`) | Stack config `env` - resolved automatically, no upload needed |
| Behaviour switches (`PLAID_ENV=sandbox`, `SEND_EMAILS_LOCALLY=false`) | Stack config `env` - pinned alongside the rest of the configuration |
| Anything non-sensitive that varies between environments | Stack config `env` |
| Preview metadata (`AUTONOMA_PREVIEWKIT`, `AUTONOMA_PREVIEWKIT_PR`, `AUTONOMA_PREVIEWKIT_URL`) | Injected automatically - reserved, no upload needed |

If you're unsure, default to the Previewkit API. You only need to think about `build_secrets` when a value must be present *during* the build (the client-bundle case above).
