---
title: Secrets
description: How to manage credentials, API keys, and other sensitive values for your Previewkit environments.
---

Anything you wouldn't commit to your repo - API keys, database URLs, signed tokens - should not live in `.preview.yaml`. Manage it through the Previewkit API instead. Every key you upload is mounted into your running app as an environment variable; your code just reads `process.env.STRIPE_API_KEY` and gets the value.

## Managing secrets

```
GET    /v1/secrets/:applicationId/:app                # list keys (no values)
PUT    /v1/secrets/:applicationId/:app                # batch upsert; body: {"items":[{"key","value"},...]}
PUT    /v1/secrets/:applicationId/:app/:key           # single upsert; body: {"value":"..."}
DELETE /v1/secrets/:applicationId/:app/:key           # delete one key
```

`applicationId` is your autonoma Application row id. Look it up once via the dashboard and hardcode it in your CI. `app` matches the `name:` field of an app inside `.preview.yaml`. For a single-app repo it's just that one name; for a monorepo each app has its own bundle.

### Authentication

Every call needs an `Authorization: Bearer <api-key>` header. Create an API key from the autonoma dashboard (Settings → API keys); keys are scoped to your organization, so they can only see and modify your own applications' secrets. Treat them like a password.

```bash
export PREVIEWKIT_API_KEY="ak_live_..."

# Batch upsert
curl -X PUT "https://previewkit.autonoma.app/v1/secrets/app_abc123/web" \
  -H "Authorization: Bearer $PREVIEWKIT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"key":"STRIPE_API_KEY","value":"sk_live_..."},{"key":"SENTRY_DSN","value":"https://..."}]}'

# Single key upsert
curl -X PUT "https://previewkit.autonoma.app/v1/secrets/app_abc123/web/STRIPE_API_KEY" \
  -H "Authorization: Bearer $PREVIEWKIT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value":"sk_live_..."}'

# List keys (names only, never values)
curl "https://previewkit.autonoma.app/v1/secrets/app_abc123/web" \
  -H "Authorization: Bearer $PREVIEWKIT_API_KEY"

# Delete
curl -X DELETE "https://previewkit.autonoma.app/v1/secrets/app_abc123/web/STRIPE_API_KEY" \
  -H "Authorization: Bearer $PREVIEWKIT_API_KEY"
```

Calls without a valid Bearer token get a 401. Calls referencing an `applicationId` your key doesn't have access to are indistinguishable from "no secrets yet" - the API never reveals whether a foreign application exists.

Updates take effect on the next preview deploy for that app.

## Build-time secrets (`build_secrets`)

`NEXT_PUBLIC_*` values for Next.js, `VITE_*` values for Vite, anything else baked into a client bundle at compile time - these need to be present during `next build` / `vite build`, not just at runtime. List them in `build_secrets:` inside `.preview.yaml` and Previewkit will pass them to your builder:

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

## Overrides committed to git

If you also define a key in `.preview.yaml`'s `env:` map, the value there wins over the uploaded one. Use this for behaviour switches that must pass code review:

```yaml
apps:
  - name: api
    port: 4000
    env:
      # A wrong API edit can't silently flip a preview into "talk to live banking".
      PLAID_ENV: "sandbox"
      SEND_EMAILS_LOCALLY: "false"
```

Template substitutions (`{{api.host}}`, `{{pr}}`, etc.) inside `env:` resolve the same way - see [environment templating](/previewkit/preview-yaml/#environment-templating).

## What goes where

| Value type | Where it lives |
|---|---|
| Third-party API keys, database URLs, signed tokens | Previewkit API |
| `NEXT_PUBLIC_*` / `VITE_*` baked into a client bundle | Previewkit API, also listed in `build_secrets` |
| In-cluster service URLs (`{{db.host}}`, `{{api.host}}`) | `.preview.yaml` env - resolved automatically, no upload needed |
| PR / owner / namespace metadata (`{{pr}}`, `{{owner}}`, `{{namespace}}`) | `.preview.yaml` env - resolved automatically, no upload needed |
| Behaviour switches that should pass code review (`PLAID_ENV=sandbox`, `SEND_EMAILS_LOCALLY=false`) | `.preview.yaml` env - keep in git so a wrong API edit can't silently flip a preview into "talk to production" mode |
| Anything non-sensitive that varies between environments | `.preview.yaml` env - reviewable in git |

If you're unsure, default to the Previewkit API. You only need to think about `build_secrets` when a value must be present *during* the build (the client-bundle case above).
