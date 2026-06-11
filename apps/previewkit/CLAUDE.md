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

Previewkit is a standalone Temporal worker - it has no HTTP server. The autonoma API owns the
public surface and starts the workflows; this app executes them.

```
GitHub pull_request webhook
  -> apps/api  (PreviewkitTriggerService; gated by the API's PREVIEWKIT_ENABLED - see below)
  -> triggerPreviewDeploy() starts previewDeployWorkflow on the `previewkit` task queue
  -> worker-previewkit runs the activities (src/activities/):
       clone repo(s) -> build images -> create namespace preview-{owner}-{repo}-pr-{N}
       -> deploy infra services + addons -> deploy app Deployments + nginx proxy + Ingress
       -> run pre/post-deploy hooks -> post/update the PR comment
```
On `pull_request.closed`, `triggerPreviewTeardown()` starts `previewTeardownWorkflow`, whose
single activity runs `TeardownPipeline` (addon deprovision + namespace delete + PR comment).

**Concurrency model:** every workflow start for a (repo, pr) - deploy, redeploy, AND teardown -
uses the same deterministic workflowId `previewkit-{slug}-{pr}`, the per-environment mutex. The
trigger (`triggers/previewkit.ts`) first issues a graceful `handle.cancel()` on the in-flight run,
then starts the new one with `TERMINATE_EXISTING` as a backstop. The graceful cancel is what frees
compute promptly: the deploy workflow observes the cancellation, the build activity's
`Context.current().cancellationSignal` aborts the `buildctl` spawn, and the builder's `finally`
releases the buildkit Job in seconds (instead of letting it run to the Job's ~31-min deadline). On
cancellation the deploy workflow writes ONLY the superseded build row (`PreviewkitBuild.status =
superseded`) and never the env row - the successor run owns it - so it must not run the failure
finalizer. Teardown runs its delete in a `nonCancellable` scope so a close-then-reopen can't leave a
half-deleted namespace.

## Directory map (`src/`)

- `worker/index.ts` - the process entrypoint (`worker.Dockerfile`); polls the `previewkit` task
  queue, registers `src/activities/`, readiness via `/tmp/worker-ready`.
- `activities/index.ts` - Temporal activity impls (prepare/build/deploy/finalize/fail/teardown);
  thin wrappers over the pipelines from `create-services.ts`.
- `create-services.ts` - builds `PreviewkitServices` (pipelines + provider) once per process.
- `env.ts` - all env vars (`createEnv`); extends `@autonoma/storage/env` + `@autonoma/logger/env`.
- `pipeline/preview-pipeline.ts` - the deploy steps the activities drive (`prepare` / `build` /
  `deployEnvironment` / `finalize` / `fail`), per-app build loop (`buildOneApp`), final-outcome
  computation, PR-comment payload.
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

## The public surface lives in apps/api

The whole `/v1/previewkit/*` HTTP surface is implemented natively in
`apps/api/src/previewkit/previewkit-http.router.ts` (auth at the edge with `requireApiKeyOrService`,
per-caller org-scoping). Previewkit itself serves nothing over HTTP.

- **Reads:** environment status (`PreviewkitEnvironmentsService` - DB), live log stream
  (SSE relay reading Grafana Loki via `LokiLogStore` behind the shared `LogStore` seam;
  `?source=build` for build output, `?source=app` for runtime stdout/stderr), secrets CRUD
  (`PreviewkitSecretsService` - AWS Secrets Manager + DB), the `.preview.yaml` JSON schema, and
  `openapi.json`. Secret values are kept out of the API request log via a body-log blocklist
  prefix on `/v1/previewkit/secrets`. Loki is a VPC-internal EC2 instance (`PREVIEWKIT_LOKI_URL`
  in the API env; unset -> the stream route 503s): build logs are pushed by this worker's
  `LokiBuildLogSink`, app logs by an Alloy DaemonSet on the preview cluster
  (`deployment/previewkit/cluster/logging/alloy.yaml`) tailing `preview-*` pod logs.
- **Lifecycle ops** (deploy / main-branch `POST /applications/:id/0` / teardown / redeploy):
  preflight + org-scoping in `PreviewkitTriggerService` (`previewkit-trigger.service.ts`, mirrors
  `diffs-trigger.service.ts`), then the Temporal workflow is started directly. 503 when the API's
  `PREVIEWKIT_ENABLED` is off (dev / self-host without preview infra); the GitHub webhook handler
  (`apps/api/src/github/github-http.router.ts`) silently skips in that case, and admin redeploy
  (`apps/api/src/routes/deployments/deployments.service.ts`) errors. `PREVIEWKIT_SERVICE_SECRET`
  remains in the API env - it authenticates the native routes and `/v1/diffs/internal/trigger`.

The admin "active environments" page reads the DB directly:
- API: `deployments.service.ts` (`listActiveEnvironments`) wired through
  `apps/api/src/routes/admin/admin.router.ts` (`admin.listPreviewkitEnvironments`,
  `admin.redeployPreviewkitEnvironment`).
- UI: `apps/ui/src/routes/_blacklight/_app-shell/admin/previewkit/index.tsx`.

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
  pending/building/deploying/ready/failed/superseded/torn_down), `phase`, `urls` (JSON appName->URL
  map), `manifest`, `resolvedConfig` + `configRevisionId` (immutable per-deploy config snapshot),
  `bypassToken`, `namespace`, `commentId`. Relations: `appInstances`, `builds`, `addons`. Note:
  `superseded` is only ever written to `PreviewkitBuild`, never the env row (the successor run owns it).
- `PreviewkitAppInstance` - per app: `appName`, `imageTag`, `url`, `port`, `ready`.
- `PreviewkitBuild` + `PreviewkitAppBuild` - per-push build + per-app build rows (normalized out
  of a former JSON column). App-build `status` enum is `success | failed` (NOT "ok"). `PreviewkitBuild`
  is `@@unique([environmentId, headSha])` so `recordBuildFinished` upserts idempotently across
  activity retries; a superseded build's row is marked `superseded`.
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

`REGISTRY_URL`, `BUILDKIT_*`, `BUILD_TIMEOUT_MS`,
`BUILD_READINESS_TIMEOUT_MS` (provisioning budget - bounds Karpenter scheduling a
buildkit node), `BUILD_STARTUP_TIMEOUT_MS` (startup budget once scheduled - image
pull + buildkitd boot), `PREVIEW_DOMAIN`,
`PREVIEW_URL_SECRET` (HMAC for hostnames), `INGRESS_CLASS_NAME`/`INGRESS_NAMESPACE`, `NGINX_IMAGE`,
`APP_URL`, `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY` (base64 PEM),
`BYPASS_TOKEN_KEY`, `EKS_*`/`AWS_REGION`, plus `S3_*` (from `@autonoma/storage/env`).
`TEMPORAL_ADDRESS`/`TEMPORAL_NAMESPACE` are read by `@autonoma/workflow`'s own env.
`LOKI_URL` (optional) - the build-log tier. When set, the builder tees each output chunk and the
pipeline mirrors phase/status transitions into Grafana Loki (`LokiBuildLogSink` behind the
`BuildLogSink` seam from `@autonoma/logger/build-log-sink`, batched + best-effort); the autonoma
API reads them back over the same `LogStore` seam and relays to clients over SSE. Loki's 31d
retention is the archive - there is no Redis tier or S3 log upload anymore (the per-attempt temp
file on disk is removed after each build attempt). Unset disables build-log publishing entirely.
The worker drains the sink's buffer on shutdown.

## Build / test

- `pnpm --filter @autonoma/previewkit typecheck` - tsc (run after any change).
- `pnpm --filter @autonoma/previewkit test` - unit tests (`vitest.config.ts`, excludes `test/integration/**` and `test/kind/**`). No Docker needed.
- `pnpm --filter @autonoma/previewkit test:integration` - Testcontainers (real Postgres). Needs Docker running.
- `pnpm --filter @autonoma/previewkit test:kind` - opt-in real-apiserver tests for `BuildKitJobManager`
  (`vitest.kind.config.ts`, `test/kind/**`). Needs the `kind` binary + Docker. Creates/reuses a dedicated
  `previewkit-readiness` kind cluster and has a hard safety gate that refuses any non-local-kind kubeconfig,
  so it can never touch a real cluster (e.g. an `agentic production` context). Because the Job pins
  `nodeSelector: arch=amd64, pool=buildkit`, the build pod is unschedulable on a stock (arm64) kind node -
  which is exactly what exercises the provision-phase readiness timeout end-to-end. Delete the cluster with
  `kind delete cluster --name previewkit-readiness`.
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
