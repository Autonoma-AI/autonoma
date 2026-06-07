# Previewkit - Agent Context

Per-PR preview environments. Previewkit reacts to GitHub `pull_request` events,
builds container images from the PR's repo, deploys them plus infra services
(Postgres, Redis, addons) into an isolated Kubernetes namespace, and posts the
preview URL back to the PR.

This file is loaded automatically when a session works under `apps/previewkit/`.
It complements:
- the repo-root `CLAUDE.md` (monorepo-wide conventions - ESM, strict TS, no `as`,
  `undefined` over `null`, Sentry logging, Zod-at-boundaries, no em dashes);
- `apps/previewkit/README.md` (the user-facing `.preview.yaml` config reference);
- the `ui-conventions` skill (required reading before editing the admin UI in
  `apps/ui/`).

When in doubt, read the source - this doc is a map, not the source of truth.

## End-to-end flow

```
GitHub pull_request webhook
  -> apps/api  (PreviewkitClient forwards to previewkit over HTTP; see "API <-> previewkit" below)
  -> previewkit POST /v1/environments  (apps/previewkit/src/routes/environments.route.ts)
  -> PreviewPipeline.deploy(event)     (src/pipeline/preview-pipeline.ts)
       clone repo(s) -> build images -> create namespace preview-{owner}-{repo}-pr-{N}
       -> deploy infra services + addons -> deploy app Deployments + nginx proxy + Ingress
       -> run pre/post-deploy hooks -> post/update the PR comment
```
On `pull_request.closed`, `TeardownPipeline` deletes the namespace.

## Directory map (`src/`)

- `app.ts` - Hono HTTP server; mounts the `/v1` routes behind auth middleware.
- `index.ts` - process entrypoint; constructs the pipeline, builder, deployer, storage.
- `env.ts` - all env vars (`createEnv`); extends `@autonoma/storage/env` + `@autonoma/logger/env`.
- `routes/` - HTTP surface: `environments.route.ts` (deploy/redeploy/teardown/main-branch),
  `health.route.ts`, `docs.route.ts` (`/openapi.json` + swagger UI) + `openapi-spec.ts`.
  (Secrets CRUD and environment status were moved to `apps/api/src/previewkit/`; see "HTTP API" below.)
- `pipeline/preview-pipeline.ts` - the core deploy orchestration (`PreviewPipeline.deploy`),
  per-app build loop (`buildOneApp`), final-outcome computation, PR-comment payload.
- `builder/` - image builds. `builder.ts` (interfaces: `Builder`, `BuildRequest`, `BuildResult`,
  `BuildRuntime`), `buildkit-builder.ts` (`buildctl` dispatch), `turbo-monorepo.ts`.
- `config/` - preview config: `schema.ts` (`previewConfigSchema`), `resolver.ts` (shared upgrade +
  validate), `file.ts` (`loadPreviewConfig` reads a repo's `.preview.yaml`), `revisions.ts`
  (`loadActiveConfig` reads the Application's active DB config revision), `index.ts`
  (`createPreviewkitDefaults`), `migrate-yaml-to-revisions.ts` (one-off `.preview.yaml` -> DB import).
  The pipeline prefers the active DB revision and falls back to the repo's `.preview.yaml`
  (`PreviewPipeline.resolvePrimaryConfig`).
- `deployer/` - turns config into K8s objects: `deployer.ts`, `resource-factory.ts`
  (Deployments/Services/Ingress/ConfigMaps, incl. the nginx proxy), `env-injector.ts`
  (`{{name.host}}` template resolution), `hook-job-runner.ts`, `pod-exec.ts`.
- `db/index.ts` - all DB writes (`record*` functions) + the in-memory `AppBuildOutcome` type.
- `addons/` - third-party resource providers (e.g. Neon) via a provider registry.
- `recipes/` - infra service recipes (postgres, redis, valkey, mongodb, upstash, api-gateway, docker-image).
- `git-provider/` - GitHub provider + the `PullRequestEvent` shape (input to `deploy`).
- `multirepo/`, `diffs/`, `secrets/` - multi-repo deps, primary-URL resolution, AWS Secrets Manager.

## HTTP API (`/v1`, auth: `requireApiKeyOrService`)

> **Canonical surface is now `apps/api`** at `/v1/previewkit/*`
> (`apps/api/src/previewkit/previewkit-http.router.ts`). Secrets CRUD, environment status, and the
> `.preview.yaml` schema were REMOVED from Previewkit and now live only in the API (implemented
> natively there). The heavy deploy/teardown/redeploy/main-branch ops below are still forwarded to
> Previewkit until they move to a Temporal worker.

Auth = `Authorization: Bearer <AUTONOMA_SERVICE_SECRET>` (service-to-service) or a DB API key.
Previewkit now serves only the deploy/teardown lifecycle (plus `/openapi.json`, `/docs`, `/health`):
- `POST /v1/environments` - deploy a PR environment (body = the `PullRequestEvent` fields).
- `POST /v1/applications/:applicationId/0` - deploy an Application's main-branch env.
- `DELETE /v1/environments/:owner/:repo/:pr?organizationId=&githubRepositoryId=` - teardown.
- `POST /v1/environments/:owner/:repo/:pr/redeploy` - re-run the pipeline at the env's current head SHA
  (reconstructs the `PullRequestEvent` from the stored row; 404 if missing, 409 if torn down).

## API <-> previewkit

They communicate over HTTP (no shared process). All autonoma-API -> Previewkit
traffic goes through one client: `apps/api/src/previewkit/previewkit-client.ts`
(`PreviewkitClient`, singleton in `previewkit-service.ts`). Config:
- `PREVIEWKIT_URL` - previewkit base URL (proxy + forwarding disabled if unset).
- `PREVIEWKIT_SERVICE_SECRET` - shared secret; must equal previewkit's `AUTONOMA_SERVICE_SECRET`.

The router `apps/api/src/previewkit/previewkit-http.router.ts` (mounted `/v1/previewkit/*`) is hybrid:
- **Native (no forwarding):** secrets CRUD (`PreviewkitSecretsService` - AWS Secrets Manager + DB),
  environment status (`PreviewkitEnvironmentsService` - reads `previewkit_environment` from the DB),
  and `GET /schema/preview.yaml.json` (static). These authenticate at the edge with
  `requireApiKeyOrService` and apply per-caller org-scoping. Secret values are kept out of the API
  request log via a body-log blocklist prefix on `/v1/previewkit/secrets`.
- **Forwarded (`PreviewkitClient.forward()`):** the heavy pipeline ops - `POST /environments`,
  `POST /applications/:id/0`, `DELETE` + `POST .../redeploy` on environments - plus `openapi.json`.
  They pass the *caller's own* `Authorization` header through to Previewkit unchanged (Previewkit
  stays the auth authority), because they run its Kubernetes + BuildKit pipeline.

Two internal callers also use `PreviewkitClient` (service-to-service, signed with the shared secret):
- **GitHub webhook forwarder** (`apps/api/src/github/github-http.router.ts`,
  `forwardPullRequestToPreviewkit`): `deploy()` / `teardown()` (teardown tolerates a 404).
- **Admin redeploy** (`apps/api/src/routes/deployments/deployments.service.ts`,
  `redeployEnvironment`): `redeploy()` (surfaces Previewkit's error detail).

The admin "active environments" page reads the DB directly (no HTTP):
- API: `deployments.service.ts` (`listActiveEnvironments`) wired through
  `apps/api/src/routes/admin/admin.router.ts` (`admin.listPreviewkitEnvironments`,
  `admin.redeployPreviewkitEnvironment`).
- UI: `apps/ui/src/routes/_blacklight/_app-shell/admin/previewkit/index.tsx`.

**Migration direction.** Previewkit is becoming a Temporal worker. Done: the public surface lives in
`apps/api`, with secrets / status / schema implemented natively. Remaining: the forwarded
deploy/teardown/redeploy ops swap from "forward over HTTP" to "start a Temporal workflow", the
pipelines move into worker activities, and Previewkit's HTTP server is retired - mirroring the diffs
pattern (`apps/api/src/diffs/` trigger -> `@autonoma/workflow` -> `apps/workers/diffs`).

## Build strategies (precedence)

`buildkit-builder.ts` `dispatchBuild` picks per app, in order:
1. **User Dockerfile** - `dockerfile:` set, or a `Dockerfile` present in the app dir
   (`resolveDockerfile` only detects an existing file - nothing is generated).
2. **Turbo monorepo** - `monorepo: turbo` set (railpack from the repo root with a filter).
3. **Railpack** - fallback auto-detection.

All paths run `buildctl` against a per-build BuildKit Job, push to `REGISTRY_URL` (ECR),
and upload build logs to S3; the PR comment links logs via 7-day presigned URLs.

## Data model (`packages/db/prisma/schema.prisma`, `Previewkit*`)

- `PreviewkitEnvironment` - one per (repo, PR). Holds `status` (enum `PreviewkitStatus`:
  pending/building/deploying/ready/failed/torn_down), `phase`, `urls` (JSON appName->URL map),
  `manifest`, `resolvedConfig` + `configRevisionId` (immutable per-deploy config snapshot),
  `bypassToken`, `namespace`, `commentId`. Relations: `appInstances`, `builds`, `addons`.
- `PreviewkitAppInstance` - per app: `appName`, `imageTag`, `url`, `port`, `ready`.
- `PreviewkitBuild` + `PreviewkitAppBuild` - per-push build + per-app build rows (normalized out
  of a former JSON column). App-build `status` enum is `success | failed` (NOT "ok").
- `PreviewkitConfigRevision` - DB-stored config revisions (the "config in DB" path).
- `PreviewkitSecret` / `PreviewkitOrgSecret` - AWS Secrets Manager ARNs per app / per org.
- `PreviewkitAddon` - provisioned addon state/outputs.

## Access proxy (`previewkit-nginx`)

Each namespace gets a `previewkit-nginx` Deployment + `previewkit-nginx-config` ConfigMap,
generated by `resource-factory.ts` `buildNginxConfig`. It fronts the app Services and used to
gate access (bypass-token header / `pk_session` cookie). The gate has been removed from the
generated config (previews are public) - read `buildNginxConfig` for the current behavior.
- The bypass-token is still generated/stored, so re-enabling the gate is a config-only change.
- Existing/running environments are patched by `scripts/disable-existing-nginx-auth.sh`.
- GOTCHA: the config is mounted via `subPath`, so editing the ConfigMap does NOT reach a running
  pod - the Deployment must be restarted to pick up changes.

## Key env vars (`src/env.ts`)

`REGISTRY_URL`, `BUILDKIT_*`, `BUILD_TIMEOUT_MS`, `PREVIEW_DOMAIN`,
`PREVIEW_URL_SECRET` (HMAC for hostnames), `INGRESS_CLASS_NAME`/`INGRESS_NAMESPACE`, `NGINX_IMAGE`,
`APP_URL`, `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY` (base64 PEM), `AUTONOMA_SERVICE_SECRET`,
`BYPASS_TOKEN_KEY`, `EKS_*`/`AWS_REGION`, plus `S3_*` (from `@autonoma/storage/env`).

## Build / test

- `pnpm --filter @autonoma/previewkit typecheck` - tsc (run after any change).
- `pnpm --filter @autonoma/previewkit test` - unit tests (`vitest.config.ts`, excludes `test/integration/**`). No Docker needed.
- `pnpm --filter @autonoma/previewkit test:integration` - Testcontainers (real Postgres). Needs Docker running.
  - Integration tests import `src/env.ts`, which (even under `TESTING=true`, which only skips the
    storage/logger env) still requires `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY` (base64-encoded PEM),
    and `PREVIEW_URL_SECRET`. Set throwaway values to run them locally.
- DB schema changes: edit `packages/db/prisma/schema.prisma` -> `pnpm db:migrate` -> `pnpm db:generate`.
  Prisma's generated migration for an enum-value rename is destructive; prefer `ALTER TYPE ... RENAME VALUE`.
- `pnpm --filter @autonoma/previewkit migrate:config [--dry-run] [--force]` - one-off: import every linked
  Application's `.preview.yaml` (at its main-branch head) into a `PreviewkitConfigRevision` and activate it.
  Idempotent (skips Applications that already have an active revision unless `--force`); needs the previewkit env.

## Gotchas

- `subPath` ConfigMap mounts don't hot-reload - restart the Deployment (see nginx note above).
- App-build status enum is `success`, not `ok`.
- The autonoma API uses `apps/api/src/routes/*.router.ts` + service classes (not the
  `routers/`+`controllers/` layout the root CLAUDE.md describes).
