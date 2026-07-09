# Previewkit - Agent Context

Per-PR preview environments. Previewkit reacts to GitHub `pull_request` events,
builds container images from the PR's repo, deploys them plus infra services
(Postgres, Redis, addons) into an isolated Kubernetes namespace, and posts the
preview URL back to the PR.

This file is loaded automatically when a session works under `apps/previewkit/`.
It complements:
- the repo-root `CLAUDE.md` (monorepo-wide conventions - ESM, strict TS, no `as`,
  `undefined` over `null`, Sentry logging, Zod-at-boundaries, no em dashes);
- `apps/previewkit/README.md` (the user-facing preview config reference);
- the `ui-conventions` skill (required reading before editing the admin UI in
  `apps/ui/`).

When in doubt, read the source - this doc is a map, not the source of truth.

## End-to-end flow

Previewkit has no long-running process - it runs as a one-shot Kubernetes Job per operation. The
autonoma API owns the public surface and launches the Jobs; this app's `src/runner` executes them.

```
GitHub pull_request webhook
  -> apps/api  (PreviewkitTriggerService; gated by the API's PREVIEWKIT_ENABLED - see below)
  -> PreviewkitJobLauncher.launchDeploy() creates a `pk-deploy-*` Job (runs apps/previewkit/src/runner):
       clone repo(s) -> build images -> create namespace preview-{owner}-{repo}-pr-{N}
       -> deploy infra services + addons -> hand namespace to the central Gatekeeper
       -> deploy app Deployments + Services
       -> run pre/post-deploy hooks -> post/update the PR comment, then exit
```
On `pull_request.closed`, `launchTeardown()` creates a `pk-teardown-*` Job that runs
`TeardownPipeline` (addon deprovision + namespace delete + PR comment). Teardown updates both PR
comments: the previewkit `"preview"` comment is replaced with a "Torn down" message, and the
`"runs"` test-results comment (owned by the run-completion job) has its now-dead "See preview"
button stripped in place via `stripCtaFromBody` (`@autonoma/github/comment`). A per-app redeploy
(`PATCH .../apps/:app`) creates a `pk-redeploy-app-*` Job (`rebuild` or `restart`).

Main-branch environments (environment 0, created via `POST /v1/previewkit/applications/:id/0`)
ride the same deploy path: a GitHub `push` webhook to the branch a live environment 0 tracks
redeploys it at the pushed head (`deployMainBranchFromPushWebhook`, action `synchronize`).
Pushes that don't update such an environment are dropped by the webhook handler before they
are even recorded - push fires for every branch of every connected repo.

**Concurrency model:** the per-environment mutex is the `previewkit.dev/env={hash}-{pr}` label on
each Job (`PreviewkitJobLauncher`, apps/api). Launching a deploy or per-app redeploy first deletes
any in-flight "deploy-family" Job for that env (`previewkit.dev/type in (deploy,redeploy-app)`,
Background propagation), then creates the new one - async newest-wins. The deleted pod gets SIGTERM,
which `src/runner/index.ts` turns into an `AbortController` abort: the build's
`signal.throwIfAborted()` / aborted `buildctl` spawn kills the build in seconds, and the
deploy branch writes ONLY the superseded build row (`PreviewkitBuild.status = superseded`), never the
env row - the successor owns it. Teardown ignores SIGTERM and runs its (idempotent) namespace delete
to completion, and the deploy-family supersede never targets a running teardown, so a
close-then-reopen can't leave a half-deleted namespace.

**Abort != failure.** A deploy/redeploy Job pod gets SIGTERM only on a deliberate supersede (a newer
push deleting the in-flight Job), so the runner treats SIGTERM as a supersede - it writes the
superseded build row and exits 0, never stamping a (possibly previously-ready) environment `failed`.
Every *handled* outcome (ready / build_failed / deploy_failed / superseded / skipped) exits 0; only
an unexpected crash exits non-zero, so the Job's `backoffLimit: 1` retries just genuine pod death
(OOM / eviction) and the idempotent DB upserts make that re-run safe. Internal timeouts
(`BUILD_TIMEOUT_MS`, the readiness budgets) record clean failures before the Job's
`activeDeadlineSeconds` backstop fires.

## Directory map (`src/`)

- `runner/` - the one-shot Kubernetes Job entrypoint. `rolldown.config.ts` bundles it into a single
  self-contained `dist/index.js` (all deps inlined, incl. the Prisma wasm compiler), which the
  multi-stage `Dockerfile` ships without any node_modules; the API launches one Job
  per deploy / teardown / per-app redeploy via `PreviewkitJobLauncher` (apps/api). `index.ts` reads
  the `PREVIEWKIT_JOB_SPEC` payload, builds `PreviewkitServices`, runs once, and exits (SIGTERM =
  supersede for deploy/redeploy-app; ignored during teardown). `run-preview-job.ts` is the
  orchestration (linear pipeline calls + a `signal.aborted` supersede branch); the `redeploy-app`
  mode is `rebuild` (build+deploy one app) or `restart` (re-roll its pods). `job-spec.ts` Zod-validates
  the payload; `deps.ts` wires the DB-backed side effects.
- `create-services.ts` - builds `PreviewkitServices` (pipelines + provider) once per process.
- `env.ts` - all env vars (`createEnv`); extends `@autonoma/storage/env` + `@autonoma/logger/env`.
- `pipeline/preview-pipeline.ts` - the deploy steps the runner drives (`prepare` / `build` /
  `deployEnvironment` / `finalize` / `fail` / `restartApp`), per-app build loop (`buildOneApp`),
  final-outcome computation, PR-comment payload.
- `builder/` - image builds. `builder.ts` (interfaces: `Builder`, `BuildRequest`, `BuildResult`,
  `BuildRuntime`), `buildkit-builder.ts` (`buildctl` dispatch), `turbo-monorepo.ts` (legacy monorepo path).
- `dockerfile-builder/generate-dockerfile.ts` - synthesizes a single-stage Dockerfile from a `build`
  framework preset (`node`/`next`/`vite`/`bun`) when an app uses the new `build` config block.
- `config/` - preview config: `schema.ts` (`previewConfigSchema`), `resolver.ts` (shared upgrade +
  validate), `revisions.ts` (`loadActiveConfig` reads the Application's active DB config revision),
  `dependency-config.ts` (`resolveDependencyConfig` - multirepo dependency repos resolve from their
  own Application's active DB revision), `index.ts` (`createPreviewkitDefaults`).
  The pipeline deploys from the active DB revision only (`PreviewPipeline.resolvePrimaryConfig`); an
  Application with no active revision is skipped, and dependencies resolve the same way in
  `cloneDependency`.
- `deployer/` - turns config into K8s objects: `deployer.ts`, `resource-factory.ts`
  (app Deployments/Services + hostnames; routing itself is the central Gatekeeper's, see below),
  `env-injector.ts` (`{{name.host}}` template resolution), `hook-job-runner.ts`, `pod-exec.ts`.
- `db/index.ts` - all DB writes (`record*` functions) + the in-memory `AppBuildOutcome` type.
- `addons/` - third-party resource providers (e.g. Neon) via a provider registry.
- `recipes/` - infra service recipes (postgres, redis, valkey, mongodb, upstash, api-gateway, docker-image, aws, temporal).
- `git-provider/` - GitHub provider + the `PullRequestEvent` shape (input to `deploy`).
- `multirepo/`, `diffs/`, `secrets/` - multi-repo deps, primary-URL resolution, AWS Secrets Manager.

## The public surface lives in apps/api

The whole `/v1/previewkit/*` HTTP surface is implemented natively in
`apps/api/src/previewkit/previewkit-http.router.ts` (auth at the edge with `requireApiKeyOrService`,
per-caller org-scoping). Previewkit itself serves nothing over HTTP.

- **Reads:** environment status (`PreviewkitEnvironmentsService` - DB), live log stream
  (SSE relay reading Grafana Loki via `LokiLogStore` behind the shared `LogStore` seam;
  `?source=build` for build output, `?source=app` for runtime stdout/stderr), secrets CRUD
  (`PreviewkitSecretsService` - AWS Secrets Manager + DB), and `openapi.json`. Secret values are
  kept out of the API request log via a body-log blocklist
  prefix on `/v1/previewkit/secrets`. Loki is a VPC-internal EC2 instance (`PREVIEWKIT_LOKI_URL`
  in the API env; unset -> the stream route 503s): build logs are pushed by the runner's
  `LokiBuildLogSink`, app logs by an Alloy DaemonSet on the preview cluster
  (`deployment/previewkit/cluster/logging/alloy.yaml`) tailing `preview-*` pod logs.
- **Lifecycle ops** (deploy / main-branch `POST /applications/:id/0` / teardown / redeploy
  `PATCH /environments/:owner/:repo/:pr` / per-app redeploy
  `PATCH /environments/:owner/:repo/:pr/apps/:app`):
  preflight + org-scoping in `PreviewkitTriggerService` (`previewkit-trigger.service.ts`, mirrors
  `diffs-trigger.service.ts`), then the Kubernetes Job is launched (PreviewkitJobLauncher). 503 when the API's
  `PREVIEWKIT_ENABLED` is off (dev / self-host without preview infra); the GitHub webhook handler
  (`apps/api/src/github/github-http.router.ts`) silently skips in that case, and admin redeploy
  (`apps/api/src/routes/deployments/deployments.service.ts`) errors. `PREVIEWKIT_SERVICE_SECRET`
  remains in the API env - it authenticates the native routes and `/v1/diffs/internal/trigger`.

The admin "active environments" page reads the DB directly:
- API: `deployments.service.ts` (`listActiveEnvironments`) wired through
  `apps/api/src/routes/admin/admin.router.ts` (`admin.listPreviewkitEnvironments`,
  `admin.redeployPreviewkitEnvironment`).
- UI: `apps/ui/src/routes/_blacklight/_app-shell/admin/previewkit/index.tsx`.

The same admin page can run a manual Environment Factory up/down against a single preview (the "Up"
button per row) to seed a scenario and pull back its credentials/cookies for hands-on failure
reproduction. It is in-memory only (no `ScenarioInstance`/`WebhookCall` rows), implemented in
`apps/api/src/routes/deployments/previewkit-env-factory.service.ts` via the DB-free
`provisionScenarioInstance`/`teardownScenarioInstance` helpers, wired through
`admin.previewkitEnvFactory{Options,Up,Down}`. It resolves the owning Application from the env's
`githubRepositoryId` + org (signing secret + scenarios), targets `<preview origin>` + the path of the
Application's main webhook, and sends the `x-previewkit-bypass` header (decrypted via
`PREVIEWKIT_BYPASS_TOKEN_KEY`) to clear Gatekeeper.

## Build strategies (precedence)

Per app, `PreviewPipeline.resolveBuildInputs` (`pipeline/preview-pipeline.ts`) selects the build inputs,
then `buildkit-builder.ts` `dispatchBuild` runs them:

1. **`build` block (preferred)** - the app's `build` is a discriminated union on `framework` (the
   `previewConfigSchema` in `packages/types`):
   - `framework: dockerfile` - use the user's Dockerfile at `build.dockerfile`. Optional `target`
     selects a stage in a multi-stage Dockerfile (buildctl `--opt target=`, like `docker build --target`);
     without it buildkit builds the LAST stage, which silently builds the wrong service when a Dockerfile
     ends with a worker/sidecar stage after the deployable one.
   - `framework: node | next | vite | bun` - `generateDockerfile()` (`dockerfile-builder/`) synthesizes a
     single-stage Dockerfile from install/build/run defaults + overrides. `build_context: app | root`
     sets the context (`root` enables a turbo `--filter` for monorepos).
2. **Legacy fallback (no `build` block)** - the older per-app fields: user `dockerfile`, `monorepo: turbo`,
   or Railpack auto-detection. Retained for back-compat, slated for removal once `build` is universal.

All paths run `buildctl` against the long-lived warm buildkitd pool
(`deployment/buildkit/buildkitd-warm.yaml`) and push to `REGISTRY_URL` (ECR). Admission is
queued (`builder/build-queue.ts`): before each attempt, the builder claims a per-pod slot
Lease in the control cluster's `buildkit` namespace (`BUILDKIT_QUEUE_SLOTS_PER_POD` per ready
pod, FIFO tickets, global across prod/beta/alpha runners - the k8s API is the one medium every
runner shares, since their DATABASE_URLs differ) and dials the granting pod's IP directly,
with rendezvous-hash cache affinity per app. A burst of pushes therefore waits in the queue
(surfaced in the build-log viewer as "Waiting for a free buildkit build slot" lines) instead
of oversubscribing the daemons; excess wait past `BUILDKIT_QUEUE_MAX_WAIT_MS` fails the build
with a clear saturation error, and queue-infrastructure failures fail OPEN to the shared
`BUILDKIT_WARM_HOST` Service (the pre-queue behavior) after a short error streak. The RBAC
grant lives in `deployment/apps/previewkit.yaml` (`previewkit-build-queue`). Pool load is
observable as `previewkit_app_builds_in_flight`, exported per env by the autonoma API's
metrics endpoint (`apps/api/src/metrics/`) from the DB's fresh `building` app rows and
summed pool-wide by the `previewkit:app_builds_in_flight:sum` recording rule
(`deployment/prometheus/alert-rules.yaml`) - buildkitd itself has no in-flight metric. An app
row stays `building` while queued, so the series measures demand (queued + running). KEDA
autoscales the pool on that series (`deployment/buildkit/buildkit-scaledobject.yaml`, min 3 /
max 8 pods at ~2 builds per pod; one pod per Karpenter node), and new pods' slots drain the
queue as soon as they are Ready. Each daemon additionally caps concurrent build steps at
`max-parallelism=4` (`deployment/buildkit/buildkitd-config.yaml`); slots-per-pod, the KEDA
threshold, and max-parallelism are tuned together around ~2 builds per pod. Build logs
stream to Grafana Loki via `LokiBuildLogSink` (see env vars below) - there is no S3 log upload. Every
attempt for a (repo, PR) shares one Loki stream (keyed by the stable `namespace`), so `PreviewPipeline.build`
calls `logSink.markStart(namespace)` at the top of each attempt to push a `kind="start"` boundary; the
API-side `LokiLogStore` replays a fresh build-log viewer only from the latest marker, so a rerun's output
overwrites prior attempts in the viewer instead of concatenating (Loki itself stays append-only).

The app-log stream gets the same treatment for deployments: `PreviewPipeline.deployEnvironment` calls
`logSink.markDeploymentStart(namespace)` (pushed with `source="app"`) as the new app pods roll out, so a
fresh app-log viewer replays forward from the latest deployment and a redeploy's runtime output supersedes
the prior deployment's lines. App lines themselves are still scraped by the Alloy DaemonSet, not pushed by
the sink; the sink writes only the marker. With no marker `LokiLogStore` falls back to tailing the newest
app lines in a recent window.

## Data model (`packages/db/prisma/schema.prisma`, `Previewkit*`)

- `PreviewkitEnvironment` - one per (repo, PR). Holds `status` (enum `PreviewkitStatus`:
  pending/building/deploying/ready/failed/superseded/torn_down), `phase`, `urls` (JSON appName->URL
  map), `resolvedConfig` + `configRevisionId` (the merged config for the latest deploy; summary/readiness views project it for display - no separate manifest column; each `config.multirepo.repos` entry is enriched with the concrete `sha` the dependency was deployed at - the per-dependency deploy provenance multi-repo grounding reads back),
  `bypassToken`, `namespace`, `commentId`. Relations: `appInstances`, `builds`, `addons`. Note:
  `superseded` is only ever written to `PreviewkitBuild`, never the env row (the successor run owns it).
- `PreviewkitAppInstance` - the per-app lifecycle record (one row per `(environment, app)`), source of
  truth for an app's status. Seeded `pending` at moment 0 (`recordAppsPending`, once the merged config names
  the apps) and transitioned through the `PreviewkitAppStatus` enum (`pending` -> `building` -> `built` ->
  `deploying` -> `ready`, or terminal `build_failed` / `deploy_failed` / `skipped`) via `recordAppStates`.
  Carries `status`, `imageTag` (null until built), `error`, `url`, `port`. A built-but-undeployed
  app is therefore a distinct queryable row, not an inferred absence. `recordEnvironmentReady` only owns the
  environment row now (status/urls/deployedAt/bypass token); the per-app rows are written separately.
- `PreviewkitBuild` + `PreviewkitAppBuild` - per-push build + per-app build rows (normalized out
  of a former JSON column). App-build `status` enum is `success | failed` (NOT "ok"). `PreviewkitBuild`
  is `@@unique([environmentId, headSha])` so `recordBuildFinished` upserts idempotently across
  Job retries; a superseded build's row is marked `superseded`.
- `PreviewkitConfigRevision` - DB-stored config revisions (the "config in DB" path).
- `PreviewkitSecret` / `PreviewkitOrgSecret` - AWS Secrets Manager ARNs per app / per org.
- `PreviewkitAddon` - provisioned addon state/outputs.

## Access proxy (`gatekeeper`, cluster mode)

One CENTRAL Gatekeeper (a standalone Go service, separate repo at `~/Code/gatekeeper`) serves every
preview: a 3-replica, leader-elected Deployment in `system`
(`deployment/previewkit/cluster/gatekeeper/`), fronted there by one wildcard Ingress for
`*.preview.autonoma.app`. Previewkit no longer stamps any proxy resources or per-app Ingresses into
preview namespaces - the contract per namespace (deployer `deployInfra` step 7) is:
- a namespaced Role + RoleBinding (`central-gatekeeper`, `buildCentralGatekeeperRole*`) granting the
  central ServiceAccount workload access in THIS namespace only - the ClusterRole deliberately has
  no workload verbs (RBAC can't scope to label selectors, and the proxy handles untrusted HTTP), so
  this stamped grant is the only thing letting Gatekeeper sleep/wake the preview;
- label `gatekeeper.dev/managed=true` opts the namespace into Gatekeeper's discovery (written by
  `NamespaceManager.ensureGatekeeperManagement`, AFTER the RBAC so discovery never races the grant);
- annotation `gatekeeper.dev/routes` carries the host -> `{service, port}` table (per-app HMAC
  hostnames; entries never name a namespace - an annotation routes only into its own);
- annotation `gatekeeper.dev/idle-timeout` (from `GATEKEEPER_IDLE_TIMEOUT`) overrides the central
  install's default per namespace.

Gatekeeper picks up label/annotation changes within milliseconds (informer watch), so redeploys
refresh routes the way re-applying the old ConfigMap did. What it does per namespace is unchanged:
**scale-to-zero** after the idle timeout (every workload matching
`TARGET_SELECTOR=previewkit.dev/managed-by=previewkit`, replica counts saved on the
`gatekeeper.dev/wake-replicas` annotation), **wake + hold** on the next request (in
`gatekeeper.dev/depends-on` dependency order), and per-namespace isolation (one preview sleeping or
waking never affects another). Auth is OFF (`AUTH_TOKEN` unset - previews are public; the
unguessable HMAC hostname is the access control, and Gatekeeper's `/_gatekeeper/routes` debug
endpoint deliberately does not exist without auth so those hostnames cannot be enumerated).

Migrating the EXISTING fleet off the old per-namespace gatekeepers is a one-time operator step, NOT
deploy-path code: `deployment/previewkit/cluster/gatekeeper/migrate-existing-previews.sh` sweeps the
old footprint (gatekeeper Deployment/Service/SA/Role/RoleBinding/ConfigMap, its apiserver-egress
NetworkPolicy, and all per-app Ingresses) per namespace, doing the handoff+cutover+teardown together
because they must be atomic (a namespace labelled for the central gatekeeper while its old one still
runs gets two idle loops on the same workloads - the central one sees no traffic and sleeps it). It
reads routes verbatim from the old `gatekeeper-routes` ConfigMap and is dry-run by default. Run it
promptly after shipping cluster mode and re-run for stragglers; the deployer's own handoff is safe
on its own only for brand-new namespaces (which have no old footprint). Debugging: `kubectl -n
system get pods -l gatekeeper.dev/role=leader` (exactly one leader carries traffic), and bad routes
annotations surface as Warning Events (`kubectl get events -n default --field-selector
reason=InvalidRoutes`).

## Key env vars (`src/env.ts`)

`REGISTRY_URL`, `DOCKER_HUB_MIRROR` (ECR pull-through cache prefix; every platform-managed
image resolving to Docker Hub - the recipe services - is
rewritten through it via `deployer/image-mirror.ts`; the Gatekeeper proxy (public.ecr.aws) and client
app images are never touched;
empty string disables), `BUILDKIT_WARM_HOST` (Service endpoint of the warm buildkitd pool;
the admission queue's fail-open fallback - admitted builds dial their granted pod directly),
`BUILDKIT_QUEUE_ENABLED` / `BUILDKIT_QUEUE_SLOTS_PER_POD` / `BUILDKIT_QUEUE_MAX_WAIT_MS` /
`BUILDKIT_QUEUE_POLL_MS` (warm-pool admission queue), `BUILD_TIMEOUT_MS`, `PREVIEW_DOMAIN`,
`PREVIEW_URL_SECRET` (HMAC for hostnames), `INGRESS_NAMESPACE` (the shared edge namespace:
Gateway + ingress-nginx + the central Gatekeeper), `GATEKEEPER_IDLE_TIMEOUT` (written per
namespace as the gatekeeper.dev/idle-timeout annotation; the Gatekeeper image itself is
pinned in `deployment/previewkit/cluster/gatekeeper/`, there is no image env var anymore),
`APP_URL`, `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY` (base64 PEM),
`BYPASS_TOKEN_KEY`, `EKS_*`/`AWS_REGION`, plus `S3_*` (from `@autonoma/storage/env`).
`PREVIEWKIT_JOB_SPEC` is the per-Job `{mode, event, ...}` payload the API sets on each runner Job.
`DATABASE_URL` is set on each runner Job by the launcher (PreviewkitJobLauncher, apps/api) to the
*launching API's own* DATABASE_URL - an explicit env var that overrides the production DATABASE_URL
carried by the shared `previewkit-env-file` secret, so a runner writes its environment/build rows to
the DB of the env that launched it (prod -> prod, beta -> beta, alpha -> that alpha env's DB).
`LOKI_URL` (optional) - the build-log tier. When set, the builder tees each output chunk and the
pipeline mirrors phase/status transitions into Grafana Loki (`LokiBuildLogSink` behind the
`BuildLogSink` seam from `@autonoma/logger/build-log-sink`, batched + best-effort); the autonoma
API reads them back over the same `LogStore` seam and relays to clients over SSE. Loki's 31d
retention is the archive - there is no Redis tier or S3 log upload anymore (the per-attempt temp
file on disk is removed after each build attempt). Unset disables build-log publishing entirely.
The runner drains the sink's buffer before it exits.

## Build / test

- `pnpm --filter @autonoma/previewkit typecheck` - tsc (run after any change).
- `pnpm --filter @autonoma/previewkit build` - rolldown bundle of the runner into `dist/` (what the
  Dockerfile's builder stage runs). `dist/index.js` boots under plain `node` - no tsx at runtime.
- `pnpm --filter @autonoma/previewkit test` - unit tests (`vitest.config.ts`, excludes `test/integration/**`). No Docker needed.
- `pnpm --filter @autonoma/previewkit test:integration` - Testcontainers (real Postgres). Needs Docker running.
  - Integration tests import `src/env.ts`, which (even under `TESTING=true`, which only skips the
    storage/logger env) still requires `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY` (base64-encoded PEM),
    and `PREVIEW_URL_SECRET`. Set throwaway values to run them locally.
- DB schema changes: edit `packages/db/prisma/schema.prisma` -> `pnpm db:migrate` -> `pnpm db:generate`.
  Prisma's generated migration for an enum-value rename is destructive; prefer `ALTER TYPE ... RENAME VALUE`.
- `scripts/apply-standard-resources.sh [--apply] [--namespace NS]` - retrofit running preview namespaces to the
  current `STANDARD_RESOURCES` tiers + replicas cap (existing workloads keep their old requests until their next
  deploy; run this after changing the standards). Dry-run by default; only touches containers still requesting
  the old 1-CPU standard, so fixed-budget containers (nginx, upstash sidecar, temporal) are never resized.
  Patching rolls the workloads, so each touched preview briefly restarts. Needs kubectl pointed at the preview
  cluster + jq.

## Gotchas

- ConfigMap-derived env/volumes are captured at pod start: changing a ConfigMap (or a `subPath`
  mount) does NOT reach a running pod - restart/redeploy it. The
  same is true of `envFrom` Secret refs, which is why `AwsExternalSecretManager.applyForNamespace`
  force-syncs ESO and waits for each target K8s Secret to be populated BEFORE app rollout, and
  `buildAppDeployment` stamps the Secret's resourceVersion as the `previewkit.dev/secret-version`
  pod-template annotation so a secret change rolls the pods. Without this, a pod can boot "ready"
  with a missing/stale `AUTONOMA_SHARED_SECRET` and every signed SDK call 401s until a manual redeploy.
- App-build status enum is `success`, not `ok`.
- The autonoma API uses `apps/api/src/routes/*.router.ts` + service classes (not the
  `routers/`+`controllers/` layout the root CLAUDE.md describes).
