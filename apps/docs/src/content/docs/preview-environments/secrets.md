---
title: Secrets
description: How to give your preview apps the credentials they need - API keys, database URLs, tokens - without committing them, and how the platform stores and injects them.
---

<p class="lead">A secret is any value you wouldn't commit to your repo - a Stripe key, a database URL, a signed token. You set it once, the platform stores it encrypted, and every preview deploy mounts it into your app as an environment variable. Your code just reads <code>process.env.STRIPE_API_KEY</code> and gets the value.</p>

![Set a secret in the config UI or via the API, it is stored encrypted in AWS Secrets Manager, then mounted as an environment variable into every preview of that app](/img/preview-environments/secret-flow.jpg)

## Two ways to set a secret

- **In the config UI (most common).** The **Variables** step of preview setup holds every variable for an app in one list, with an editor beside it. This is the right place for a one-off, or when you're setting things up by hand for the first time.
- **From the API (for CI / automation).** Script it when you have many keys, or rotate them from a pipeline. See [Managing secrets from the API](#managing-secrets-from-the-api) below.

![The Variables step of preview setup. On the left a list splits into two groups - Connections, holding DATABASE_URL with an arrow to db and a BUILD chip, and Secrets, holding STRIPE_SECRET_KEY and RESEND_API_KEY, each with a padlock. On the right an "Edit variable" panel shows the selected key, a Source control switching between SECRET and CONNECTION with SECRET active and the note "stored encrypted in AWS, injected at runtime, never shown again after saving", a value field reading "•••••• (set)" with a Replace value button and the note that the stored value can't be read back, and an Injection block reading "injected at runtime - always on for every variable" with an "also inject at build time" toggle beneath it](/img/preview-environments/variables-secret.png)

Two things in that panel are worth knowing before you start. A saved secret can only be **replaced**, never read back - the value field shows `•••••• (set)` and nothing else. And the **Source** control is where the secret-versus-connection decision below actually gets made, with the product writing the one-line rationale for each next to it.

Both routes write to the same encrypted store, so a value set in the UI is visible to the API and vice versa. The value lives in AWS Secrets Manager - never in your config, never in your repo - and is only ever readable by your own organization. Updates take effect on the next preview deploy for that app.

Because a secret lives outside the config, it also saves on its own. When the only thing you have changed is secrets, the save button reads **Save secrets** and writes just those - so a rotation goes through even when the rest of the config is mid-edit or has a problem of its own. Changing a variable's build-time toggle is the exception: that names the key in `build_secrets`, which is part of the config, so it saves with the config like any other setting.

## Secret, connection, or config value?

Not everything your app reads from `process.env` is a secret. Picking the right home is the thing people get wrong most often, so start here:

![Decision flow: a sensitive value becomes a Secret, the address of another app or service (or a non-sensitive literal) becomes a Connection, and a value needed during the build becomes a build secret](/img/preview-environments/what-goes-where.jpg)

| Value | Where it goes | Why |
| --- | --- | --- |
| Sensitive - API keys, database URLs, signed tokens | **Secret** (UI Variables step or API) | Stored encrypted, never in the repo or config. |
| The address of another app/service in the same preview (`{{db.host}}`, `{{api.url}}`) | **[Connection](/preview-environments/connections/)** - a templated value in the Variables step | The platform resolves the real in-cluster address at deploy time. Nothing to upload. |
| Non-sensitive value that varies per environment (`PLAID_ENV=sandbox`) | **[Connection](/preview-environments/connections/)** with a literal value | Pinned alongside the rest of the config. Nothing to upload. |
| A value baked into a client bundle at build time (`NEXT_PUBLIC_*`, `VITE_*`) | **Secret + `build_secrets`** | Must be present *during* the build, not just at runtime. See [Build-time secrets](#build-time-secrets-build_secrets). |
| PR / owner / namespace metadata (`{{pr}}`, `AUTONOMA_PREVIEWKIT_PR`) | Injected automatically | Reserved built-ins. See [Built-in environment variables](#built-in-environment-variables). |

When in doubt, if the value is sensitive, make it a **Secret**. A secret added in the UI is build-time by default, so the client-bundle case works without you thinking about it - see [Build-time secrets](#build-time-secrets-build_secrets) for when to turn that off.

## Managing secrets from the API

Automate secrets from CI with four endpoints:

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

## Build-time secrets (`build_secrets`)

`NEXT_PUBLIC_*` values for Next.js, `VITE_*` values for Vite, anything else baked into a client bundle at compile time - these need to be present during `next build` / `vite build`, not just at runtime. List them in an app's `build_secrets` and Autonoma will pass them to your builder:

```yaml
apps:
  - name: web
    port: 3000
    build_secrets:
      - NEXT_PUBLIC_FIREBASE_API_KEY
      - NEXT_PUBLIC_FIREBASE_PROJECT_ID
      - NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
```

Each name must already be a key you've uploaded (via the UI or the API). The build fails fast with a clear error if a listed key isn't there.

In the config UI you don't list these by hand: a variable you add has **Also inject at build time** on, so the build can see it, and the editor writes the key into `build_secrets` for you. Turn the toggle off for a value the build must not see - a build-time value is written into the image, so anyone who can pull that image can read it. Preview images are private to your organization and thrown away with the preview, which is why the default leans towards builds that work; a value you would not want in an image belongs off the toggle (or in the runtime mount only).

Server-only secrets (those your running pod reads via `process.env`) do not *need* to be in `build_secrets` - the runtime mount already covers them.

## Config-level overrides

If you also define a key as an app [connection](/preview-environments/connections/) in your stack configuration, the connection's value wins over the uploaded secret. Use this for behaviour switches you want pinned alongside the rest of the config:

```yaml
apps:
  - name: api
    port: 4000
    connections:
      # Pin a preview to safe defaults so it can't talk to live services.
      - key: PLAID_ENV
        value: "sandbox"
      - key: SEND_EMAILS_LOCALLY
        value: "false"
```

Connection values are templates - `{{api.host}}`, `{{pr}}`, and friends resolve at deploy time. See the [template reference](/preview-environments/connections/#template-reference).

## Built-in environment variables

Autonoma injects a few variables into every preview app automatically. You don't upload them, and you can't override them - the names are reserved, so the API rejects any secret you try to set with one of these keys.

| Variable | Value | Notes |
| --- | --- | --- |
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
