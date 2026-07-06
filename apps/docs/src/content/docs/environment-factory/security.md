---
title: Security & Troubleshooting
description: The Environment Factory's two secrets, three security layers, and hard safety guarantees - plus a full reference of error codes and common fixes.
---

The endpoint creates and deletes data, so it's protected by three independent layers and two separate secrets. This page also collects every error code and the fixes for the problems you're most likely to hit.

## The two secrets

Two secrets with different jobs. They **must be different values** - the SDK throws `SAME_SECRETS` at startup if they match.

| Secret | Env variable | Who knows it | Purpose |
| --- | --- | --- | --- |
| **Shared secret** | `AUTONOMA_SHARED_SECRET` | You + Autonoma | HMAC-signs every request. Autonoma signs; your SDK verifies. |
| **Signing secret** | `AUTONOMA_SIGNING_SECRET` | Only you | Signs the teardown token during `up`, verifies it during `down`. Autonoma stores it opaquely and can't read it. |

```bash
openssl rand -hex 32   # AUTONOMA_SHARED_SECRET
openssl rand -hex 32   # AUTONOMA_SIGNING_SECRET (must differ)
```

## The three layers

![Three layers protect the endpoint: a production guard, request signing, and a signed teardown token](/img/environment-factory/security-layers.jpg)

**Layer 1 - Production guard.** The endpoint returns `404` whenever the app runs in production, unless you set `allowProduction: true`. Even if someone finds the URL, it stays dark in production. Each SDK reads its ecosystem's standard production signal - `NODE_ENV=production` for Node, `DJANGO_SETTINGS_MODULE` / `DEBUG=False` for Django, `MIX_ENV=prod` for Elixir, `APP_ENV`/`RAILS_ENV` for PHP and Rails, and so on.

**Layer 2 - Request signing (HMAC-SHA256).** Every request carries an `x-signature` header: the HMAC-SHA256 of the raw body, keyed with the shared secret. The SDK verifies it automatically and rejects unsigned or tampered requests with `401`.

**Layer 3 - Signed refs token.** When `up` creates data, the SDK signs the created record IDs into a `refsToken` using the signing secret. On `down`, it verifies that token before deleting anything - so `down` can only ever delete what `up` actually created. Autonoma just stores the opaque string and passes it back; it cannot forge or modify it.

| Attack | Why it fails |
| --- | --- |
| Fake refs with made-up IDs | No valid token → rejected |
| A real token with altered refs | Refs don't match the token → rejected |
| A replayed token from last week | Token expired (24h) → rejected |

## What the SDK can and cannot do

- **`up` can only create.** It invokes the factories you registered, which call your own services. It cannot update, delete, drop, truncate, or run raw SQL outside your factory bodies.
- **`down` can only delete what `up` created**, verified by the signed token. It calls each factory's `teardown` in reverse order.
- **The SDK never runs SQL itself.** It calls your factories; they use whatever client your app already has.

## Error codes

Every code the endpoint can return, with its fix:

| Code | HTTP | Meaning | Fix |
| --- | --- | --- | --- |
| `INVALID_SIGNATURE` | 401 | HMAC signature missing or doesn't match | Make `AUTONOMA_SHARED_SECRET` match the value Autonoma uses for your app |
| `INVALID_BODY` | 400 | Body isn't valid JSON, or a required field is missing | Match each record to its own top-level model key and supply every required field |
| `UNKNOWN_ACTION` | 400 | `action` isn't `discover`, `up`, or `down` | Check the request is one of the three actions |
| `INVALID_REFS_TOKEN` | 403 | Refs token missing, malformed, or failed verification | Use the same `AUTONOMA_SIGNING_SECRET` between `up` and `down` |
| `PRODUCTION_BLOCKED` | 404 | Endpoint disabled in production mode | Set `allowProduction: true`, or ensure the app isn't in production mode |
| `SAME_SECRETS` | 500 | `sharedSecret` and `signingSecret` are identical | Use two different `openssl rand -hex 32` values |
| `FACTORY_MISSING_PK` | 500 | A factory's `create` didn't return an id | Return at least `{ id: "..." }` from every `create` |
| `INTERNAL_ERROR` | 500 | Unexpected server error | Check your factory bodies and server logs |

## Other common problems

These aren't error codes - they surface as database or validation failures:

| Problem | Cause | Fix |
| --- | --- | --- |
| FK violation on `up` | A required foreign key is missing | Set every FK (including the scope field) explicitly as a `{ "_ref": "alias" }` |
| `Invalid input for "<Model>"` | Missing required field, or records under the wrong model key | Match each record to its own top-level model key and supply every required field |
| `references unknown alias(es)` | A `_ref` points at an alias no record declares | Declare the alias with `_alias` in the same payload, or fix the typo |
| FK violation on `down` | Circular FK between tables | The SDK handles cycles with deferred updates; if it still fails, check for untracked FKs |
| Parallel tests collide | Same email/slug across runs | Put `testRunId` in every unique field |
