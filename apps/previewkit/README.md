# Previewkit

Preview environments for pull requests. Deploy any stack to Kubernetes without changing your code.

Previewkit builds container images from your repo and deploys them alongside infrastructure services (Postgres, Redis, etc.) into an isolated Kubernetes namespace, then posts the preview URL back to your PR. GitHub `pull_request` events are received by the autonoma API and forwarded to Previewkit.

## How It Works

```
PR opened/updated
      |
      v
  Webhook received by the autonoma API, forwarded to Previewkit
      |
      v
  Resolve the Application's active config revision
      |
      v
  Clone repo, build images (Railpack or Dockerfile)
      |
      v
  Create K8s namespace: preview-{owner}-{repo}-pr-{N}
      |
      v
  Deploy infrastructure services (Postgres, Redis)
      |
      v
  Load per-app secrets, merge with config env, resolve templates
      |
      v
  Deploy app containers + Ingress
      |
      v
  Run post-deploy hooks (migrations, seeds)
      |
      v
  Comment on PR with preview URLs
```

On PR close, the entire namespace is deleted.

## Config source

Previewkit deploys from the Application's **active config revision** - a `PreviewkitConfigRevision` row holding the preview config document, authored from the Autonoma dashboard (e.g. the PreviewKit onboarding topology builder). An Application with no active revision opts out: its pull requests are skipped.

The same applies to multirepo dependency repos (`config.multirepo.repos`): each dependency repo's own Application active revision is used. A dependency repo with no active revision is skipped.

## Config document

The preview config is authored from the Autonoma dashboard and stored as a `PreviewkitConfigRevision`. It has the following shape (shown here as YAML for readability):

```yaml
version: 1
domain: preview.example.com
registry: ghcr.io/my-org

apps:
  - name: web
    path: ./apps/web
    port: 3000
    env:
      API_URL: "http://{{api.host}}:{{api.port}}"
      DATABASE_URL: "postgresql://preview:preview@{{db.host}}:5432/preview"
    health_check: /health

  - name: api
    path: ./apps/api
    port: 4000
    dockerfile: ./apps/api/Dockerfile
    env:
      DATABASE_URL: "postgresql://preview:preview@{{db.host}}:5432/preview"
      REDIS_URL: "redis://{{cache.host}}:6379"
    health_check: /health

services:
  - name: db
    recipe: postgres
    version: "16"

  - name: cache
    recipe: redis

hooks:
  post_deploy:
    - app: api
      command: "npx prisma migrate deploy"
```

### Config Reference

**Top-level fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `version` | Yes | Must be `1` |
| `domain` | No | Preview domain. Overrides `PREVIEW_DOMAIN` env var |
| `registry` | No | Container registry. Overrides `REGISTRY_URL` env var |
| `apps` | Yes | List of app definitions (at least one) |
| `services` | No | List of infrastructure services |
| `addons` | No | Third-party managed resources via provider plugins (e.g. Neon) |
| `hooks` | No | Lifecycle hooks (`pre_deploy` / `post_deploy`) |
| `config` | No | Advanced settings, e.g. `config.multirepo` for multi-repo dependencies |

**App fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | | Lowercase alphanumeric + hyphens. Used in K8s resource names and URLs |
| `path` | No | `.` | Path to the app directory relative to repo root |
| `port` | Yes | | Port the app listens on |
| `dockerfile` | No | | Path to a Dockerfile relative to repo root. If absent, the build falls back to Turbo (when `monorepo` is set) or Railpack |
| `build_context` | No | | Build context directory. Useful for monorepos |
| `monorepo` | No | | Workspace build tool. Currently only `turbo`; builds from the repo root with a filter for this app |
| `build_args` | No | `{}` | Docker build arguments |
| `build_secrets` | No | `[]` | Names of uploaded secrets to expose at build time (e.g. `NEXT_PUBLIC_*`); each must already be uploaded via the secrets API |
| `env` | No | `{}` | Environment variables. Supports `{{name.host}}`, `{{name.port}}` and `{{name.url}}` templates |
| `command` | No | | Override the container command |
| `health_check` | No | | HTTP path for readiness/liveness probes |
| `replicas` | No | `1` | Number of pod replicas. Capped at 3 (platform policy); higher values are clamped, not rejected |
| `primary` | No | | Marks this app as the environment's primary URL |
| `depends_on` | No | | Names of apps/services this app waits for before starting |
| `resources` | No | | **Ignored for user-authored config.** App containers request 250m CPU / 512Mi memory with a 1Gi memory limit; CPU is never limited, so apps burst freely. The field is still accepted so existing configs validate, but its `cpu`/`memory` values have no effect here - resource sizing is honored only for trusted, platform-authored config. |

**Service fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | | Name used in `{{name.host}}` templates |
| `recipe` | Yes | | One of: `postgres`, `redis`, `valkey`, `temporal`, `mongodb`, `upstash`, `api-gateway`, `docker-image` |
| `version` | No | | Image tag (e.g. `"16"` for `postgres:16`) |
| `env` | No | `{}` | Extra environment variables for the service container |
| `options` | No | `{}` | Recipe-specific options (e.g. `docker-image`'s `image` / `port` / `readiness`) |
| `resources` | No | | **Ignored for user-authored config** (see app fields). Service containers request 100m CPU / 256Mi memory with a 1Gi memory limit. |

### Template Syntax

Use `{{name.host}}`, `{{name.port}}` and `{{name.url}}` in `env` values to reference other apps or services within the preview namespace:

```yaml
env:
  # Reference a service by host/port
  DATABASE_URL: "postgresql://preview:preview@{{db.host}}:{{db.port}}/preview"

  # Or let the recipe build the whole connection string with `.url`
  DATABASE_URL: "{{db.url}}"

  # Reference another app
  API_URL: "http://{{api.host}}:{{api.port}}"
```

`{{name.host}}` / `{{name.port}}` resolve to the Kubernetes service DNS name and port within the namespace (e.g. `db`, `api`).

`{{name.url}}` resolves to:
- an **app**'s public HTTPS preview URL, or
- a **service**'s in-cluster connection string, when the recipe defines a well-known scheme:
  - `postgres` -> `postgresql://preview:preview@<host>:<port>/preview`
  - `redis` / `valkey` -> `redis://<host>:<port>`
  - `mongodb` -> `mongodb://<host>:<port>/?directConnection=true`

Recipes without a single-scheme URL (e.g. `temporal`, `api-gateway`) don't support `{{name.url}}` - use `{{name.host}}` / `{{name.port}}` for those.

### Built-in Environment Variables

Every app pod is injected with these at deploy time (`Deployer.deployApp`). The names are reserved - the secrets API rejects uploads using them, and they always override any user-set value (config `env` or a stored secret):

| Variable | Value |
| --- | --- |
| `AUTONOMA_PREVIEWKIT` | `true` |
| `AUTONOMA_PREVIEWKIT_PR` | The pull request number (e.g. `123`) |
| `AUTONOMA_PREVIEWKIT_URL` | This app's public URL, `https://{hash}.{domain}` (per-app) |

The reserved key set lives in `@autonoma/types` (`PREVIEWKIT_BUILTIN_ENV_VARS` / `isReservedPreviewkitEnvKey`).

## Secrets Management

Secrets are stored in AWS Secrets Manager, one bundle per (application, app) under the name `previewkit/{org-slug}/{application}/{app}`. They are never committed to your repository. At deploy time the External Secrets Operator mirrors each bundle into a Kubernetes Secret (`{app}-secrets`) in the preview namespace, which the app Deployment mounts via `envFrom`. Build-time secrets (`build_secrets`) are fetched straight from AWS Secrets Manager and passed as Docker build args.

At deploy time, secrets are merged with the config's env vars. The config takes priority, allowing you to override connection strings for preview infrastructure while keeping API keys in the secret store:

```
Stored secrets (base)  -> { DATABASE_URL: "postgres://prod:5432", OPENAI_API_KEY: "sk-..." }
Config env (override)  -> { DATABASE_URL: "postgresql://preview:preview@{{db.host}}:5432/preview" }
After merge + resolve  -> { DATABASE_URL: "postgresql://preview:preview@db:5432/preview", OPENAI_API_KEY: "sk-..." }
```

### API Routes

> **The HTTP API lives in the autonoma API**, under `/v1/previewkit/*`. Previewkit itself is a
> Temporal worker with no HTTP server - the API serves secrets/status natively and starts the
> deploy/teardown/redeploy workflows that this worker executes. Point all integrations at the
> autonoma API. Authenticate with an `Authorization: Bearer <api-key>` header; keys are scoped to
> your organization.

#### Secrets

Per-app build + runtime secrets, scoped to your organization's applications:

```
GET    /v1/previewkit/secrets/:applicationId/:app          List keys (values never returned)
PUT    /v1/previewkit/secrets/:applicationId/:app          Batch upsert ({"items":[{"key","value"},...]})
PUT    /v1/previewkit/secrets/:applicationId/:app/:key     Save one secret ({"value":"..."})
DELETE /v1/previewkit/secrets/:applicationId/:app/:key     Delete one secret
```

`applicationId` is your autonoma Application id; `app` matches an app `name:` in the preview config.

**Save a secret:**

```bash
curl -X PUT https://api.example.com/v1/previewkit/secrets/app_abc123/api/OPENAI_API_KEY \
  -H "Authorization: Bearer $AUTONOMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value": "sk-..."}'
```

**List secret keys:**

```bash
curl https://api.example.com/v1/previewkit/secrets/app_abc123/api \
  -H "Authorization: Bearer $AUTONOMA_API_KEY"
# {"applicationId":"app_abc123","app":"api","keys":[{"key":"OPENAI_API_KEY","maskedLength":8,"updatedAt":"2024-01-01T00:00:00.000Z"}]}
```

**Delete a secret:**

```bash
curl -X DELETE https://api.example.com/v1/previewkit/secrets/app_abc123/api/STRIPE_KEY \
  -H "Authorization: Bearer $AUTONOMA_API_KEY"
```

Each app gets its own bundle - the `api` container never sees `web`'s secrets and vice versa.

#### Webhooks

GitHub `pull_request` events are received by the autonoma API at `POST /v1/github/webhook`, which
starts the deploy/teardown Temporal workflows. Configure your GitHub App's webhook URL there.

GitHub `push` events arrive at the same endpoint: a push to the branch a live main-branch
environment (environment 0) tracks redeploys it at the pushed head, the same way `synchronize`
updates a PR environment. Pushes to any other branch are ignored (and not recorded).

## Environment Variables

Defined and validated in `src/env.ts`, which also extends `@autonoma/storage/env` (`S3_*`) and `@autonoma/logger/env` (`SENTRY_DSN`, `LOG_LEVEL`).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_APP_ID` | Yes | | GitHub App ID |
| `GITHUB_PRIVATE_KEY` | Yes | | GitHub App private key, base64-encoded PEM (`cat key.pem \| base64`) |
| `PREVIEW_URL_SECRET` | Yes | | HMAC key for deterministic, unguessable preview hostnames |
| `PREVIEW_DOMAIN` | No | `preview.autonoma.app` | Base domain for preview URLs (wildcard DNS must point at the shared gateway) |
| `REGISTRY_URL` | No | `registry.previewkit.svc.cluster.local:5000` | Container image registry (ECR in production) |
| `DOCKER_HUB_MIRROR` | No | `140023360995.dkr.ecr.us-east-1.amazonaws.com/docker-hub` | ECR pull-through cache prefix. Every platform-managed image that resolves to Docker Hub (service recipes, the nginx access proxy) is rewritten to pull through it; official images get the `library/` namespace. Other registries are never rewritten. Empty string disables mirroring |
| `BUILDKIT_BUILD_NAMESPACE` | No | `buildkit` | Namespace where per-build BuildKit Jobs are spawned |
| `BUILDKIT_IMAGE` | No | `moby/buildkit:v0.21.1` | Image used for build Jobs |
| `BUILDKIT_BUILDER_SERVICE_ACCOUNT` | No | `buildkitd` | ServiceAccount each build pod runs as (needs IRSA for the S3 cache) |
| `BUILD_TIMEOUT_MS` | No | `1800000` | Per-build timeout (30 min) |
| `BUILD_READINESS_TIMEOUT_MS` | No | `600000` | Provisioning budget: how long to wait for a build pod to be scheduled onto a node (survives a Karpenter node scale-up) |
| `BUILD_STARTUP_TIMEOUT_MS` | No | `180000` | Startup budget: once scheduled, how long to wait for the pod to become Ready (image pull + buildkitd boot) |
| `INGRESS_CLASS_NAME` | No | `nginx` | Ingress class for preview Ingresses |
| `INGRESS_NAMESPACE` | No | `system` | Namespace of the shared ingress controller |
| `GATEKEEPER_IMAGE` | No | `public.ecr.aws/autonoma/gatekeeper:latest` | Image for the per-namespace Gatekeeper auth + scale-to-zero proxy |
| `GATEKEEPER_IDLE_TIMEOUT` | No | `30m` | Idle duration before Gatekeeper scales an env's workloads to zero (Go duration string) |
| `CLUSTER_SECRET_STORE_NAME` | No | `aws-secretsmanager` | ClusterSecretStore (External Secrets Operator) pointing at AWS Secrets Manager |
| `APP_URL` | No | `https://beta.autonoma.app` | autonoma app base URL (used in PR comments) |
| `BYPASS_TOKEN_KEY` | No | | AES-256-GCM key (64 hex chars) for encrypting bypass tokens; must match the API's `PREVIEWKIT_BYPASS_TOKEN_KEY` |
| `KUBECONFIG` | No | | Path to kubeconfig. If unset, uses in-cluster config |
| `EKS_CLUSTER_NAME` | No | | Cross-cluster EKS target; when set, authenticates via the AWS SDK instead of `KUBECONFIG` |
| `AWS_REGION` | No | | Required when `EKS_CLUSTER_NAME` is set (and for AWS Secrets Manager) |

## Preview URL Format

Each app gets an opaque URL whose subdomain is a deterministic hash of the service name, PR number, and repo. This keeps URLs stable across re-deploys while not leaking any of those values in the address.

```
https://{12-char-hex}.{PREVIEW_DOMAIN}
```

For example, PR #42 with apps `web` and `api`:

```
https://a3f8b21c4d9e.preview.example.com
https://7c902ef1ab34.preview.example.com
```

Requires a wildcard DNS record `*.preview.example.com` pointing to your ingress controller.

## Building Images

Previewkit builds each app with BuildKit (rootless, no Docker daemon), choosing a strategy in this order:

1. **Dockerfile** -- if you set the app's `dockerfile` field, or a `Dockerfile` exists in the app directory, it is built with [BuildKit](https://github.com/moby/buildkit) via `buildctl`.
2. **Turbo monorepo** -- if the app sets `monorepo: turbo`, the build runs from the repo root with a Turbo filter for that app.
3. **Railpack** -- otherwise [Railpack](https://railpack.com) auto-detects the language and framework and builds via BuildKit. Supports Node.js, Go, Python, PHP, Java, Ruby, and more.

All paths push to the configured registry.

**Image tag format:** `{registry}/{owner}/{repo}:{app-name}-pr-{N}-{short-sha}` (e.g. `ghcr.io/my-org/my-repo:api-pr-42-a1b2c3d4`)

## Infrastructure Recipes

Recipes are built-in definitions for common infrastructure services deployed alongside your apps.

| Recipe | Image | Port | Notes |
|--------|-------|------|-------|
| `postgres` | Previewkit's bundled image (broad extension set) | 5432 | StatefulSet with PVC. user/password/db all `preview`. Set `version` for stock `postgres:{version}`, or pin `options.image` (allowed prefixes: `postgres:`, `postgis/postgis:`, `pgvector/pgvector:`, `google/alloydbomni`). Extra databases + extensions via `options` (see below) |
| `redis` | `redis:{version}-alpine` | 6379 | Deployment, no persistence. Default version `7-alpine` |
| `valkey` | `valkey/valkey:{version}` | 6379 | Deployment, no persistence. Default version `8-alpine` |
| `mongodb` | `mongo:{version}` | 27017 | StatefulSet with PVC. Single-node replica set (Change Streams); connect with `directConnection=true`. Default version `7` |
| `temporal` | `temporalio/temporal:{version}` | 7233 (gRPC), 8233 (UI) | Deployment, `start-dev` mode |
| `upstash` | `hiett/serverless-redis-http` + `redis` sidecar | 8000 (REST), 6379 (RESP) | Serverless-Redis-HTTP proxy over a Redis sidecar in one Pod. Exposes both the REST port (for `@upstash/redis`/`@vercel/kv` via `KV_REST_API_URL`) and the raw Redis port (for `ioredis`/`KV_URL`), like real Vercel KV. `{{cache.port}}` resolves to the REST port. Default token `local-dev-token` |
| `api-gateway` | `nginx:{version}-alpine` | 80 | Deployment. Routes requests to backend services. Default version `1.27-alpine` |
| `docker-image` | Configured via `options.image` | Configured via `options.port` | Generic recipe for any service; see below |

**Docker Hub mirroring:** every recipe image that resolves to Docker Hub (including a `docker-image` `options.image` like `minio/minio`) is transparently rewritten to pull through the ECR pull-through cache (`DOCKER_HUB_MIRROR`), avoiding Docker Hub rate limits. Images on other registries (`ghcr.io`, ECR, ...) are pulled directly. The same mirroring covers the BuildKit Job image (`moby/buildkit`); the per-namespace Gatekeeper proxy runs from `public.ecr.aws`, so it is pulled directly. Images built from your repo are pushed to and pulled from our own registry and are never rewritten.

### `api-gateway`

An nginx reverse proxy that routes incoming paths to backend services. Each route becomes an nginx `location` block that proxies to its `target` (request-time DNS resolution, so targets that don't exist yet at deploy time still work).

```yaml
services:
  - name: api-gateway
    recipe: api-gateway
    options:
      client_max_body_size: 25m
      inject_headers:
        x-gateway-source: api-gateway-proxy
      routes:
        - path: /graphql
          target: subgraph-core:4001
        - path: /api/
          target: platform-user-service:3000
          strip_prefix: true
```

**`options` fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `routes` | Yes | At least one route. Each: `path` (location prefix), `target` (`host:port`, resolved against the namespace if it has no dot), optional `strip_prefix` (drop `path` before forwarding), optional `rewrite` (custom prefix rewrite) |
| `client_max_body_size` | No | nginx `client_max_body_size`. Default `10m` |
| `inject_headers` | No | Map of header -> value added to **every** proxied request via `proxy_set_header`. Since `proxy_set_header` overrides any client-supplied value, this is also how you stamp a trusted gateway-identity header (e.g. `x-gateway-source: api-gateway-proxy`) that upstreams can rely on - clients cannot spoof a header the gateway always overwrites. Header names must be valid HTTP tokens; values cannot contain double quotes or newlines |

Routes are matched most-specific-first (longest `path` wins). The gateway also serves `GET /_health` (200) for its own readiness probe.

### `postgres`

By default the `postgres` recipe runs **Previewkit's own image**, built from
[`postgres.Dockerfile`](postgres.Dockerfile), which bundles a broad set of extensions on top of the
standard contrib modules. That image is the source of truth for which extensions are available -
there is no code-side allowlist, so anything baked into it can be requested via `options.extensions`.

The bundled set mirrors what [Neon](https://github.com/neondatabase/neon) ships, minus the
heavyweight builds (plv8, rdkit, pg_duckdb, pg_mooncake, pgrag). Highlights:

- **Search / types:** `vector` (pgvector), `postgis` (+ `postgis_raster`, `postgis_topology`),
  `pgrouting`, `h3` / `h3_postgis`, `hll`, `rum`, `ip4r`, `prefix`, `unit`, `semver`,
  `roaringbitmap`, `pg_uuidv7`, `pgx_ulid`, `pg_hashids`.
- **App / API:** `pg_graphql`, `pg_jsonschema`, `pg_tiktoken`, `pgjwt`, `pg_session_jwt` (JWT-backed
  RLS), plus contrib (`uuid-ossp`, `pgcrypto`, `citext`, `hstore`, `pg_trgm`, `ltree`, ...).
- **Ops / time-series:** `timescaledb`, `pg_cron`, `pg_partman`, `pg_repack`, `pg_ivm`, `hypopg`,
  `pg_hint_plan`, `plpgsql_check`, `pgaudit`, `pgauditlogtofile`, `wal2json`, `pgtap`.

Beyond the defaults, `postgres` accepts these `options`:

```yaml
services:
  - name: db
    recipe: postgres
    options:
      databases: [analytics, jobs]      # extra databases created alongside the default `preview`
      extensions: [uuid-ossp, pgcrypto, vector, postgis, timescaledb]
      storage: 5Gi                      # PVC size (default 1Gi)
      image: postgres:17                # optional: pin a specific image (see precedence below)
```

`databases` and `extensions` are applied once, at first init, via a mounted init script. Each
extension is created (`CREATE EXTENSION IF NOT EXISTS ... CASCADE`) in the default `preview` database
and in every extra database. To make a new extension available, install it in
[`postgres.Dockerfile`](postgres.Dockerfile).

A few extensions (`timescaledb`, `pg_cron`, `pgaudit`) only load via `shared_preload_libraries`. When
you request one of them on the default image, the recipe sets `shared_preload_libraries` for you - no
extra config needed. This applies to the default image only; a pinned `options.image`/`version` is left
untouched, since preloading a library it doesn't ship would crash startup.

**Image precedence:** `options.image` (if set) wins; otherwise an explicit `version` selects the
matching stock `postgres:{version}` (which carries only the contrib extensions, not the baked ones);
otherwise the default image. An extension requested against an image that doesn't bundle it fails at
init time, so only override `options.image`/`version` when you don't need the baked extensions.

### `docker-image`

Use `docker-image` to deploy any container without writing a dedicated recipe. The image, port, command, and readiness probe are configured via `options`.

```yaml
services:
  - name: sandbar
    recipe: docker-image
    options:
      image: ghcr.io/permify/permify:latest
      port: 3476
      command: ["serve"]
      args: ["--database-engine=memory"]
      readiness:
        tcp: {}            # or: http: { path: "/health" }, or: exec: { command: ["..."] }
```

**`options` fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `image` | Yes | Full image reference (e.g. `ghcr.io/org/app:tag`) |
| `port` | No | Primary container port. Omit for workers / jobs that don't need a Service |
| `command` | No | Container `command` (entrypoint override) |
| `args` | No | Container `args` |
| `env` | No | Extra env vars merged on top of the service-level `env:` (options wins on collision) |
| `additional_ports` | No | Extra named ports exposed by the Service: `[{ name, port }]` |
| `readiness` | No | Exactly one of `http`, `exec`, `tcp`. Omit for instant readiness |

For `readiness.http` and `readiness.tcp`, the probe port defaults to `options.port` if not set. `readiness` also accepts optional `initial_delay_seconds` and `period_seconds`.

## Kubernetes Resources

Each preview environment gets its own namespace with full isolation:

```
Namespace: preview-{owner}-{repo}-pr-{N}
  ├── StatefulSet + Service + PVC    (per infrastructure service)
  ├── Deployment + Service + Ingress (per app)
  └── Labels: previewkit.dev/managed-by, previewkit.dev/pr-number, previewkit.dev/repo
```

Namespace annotations store state (comment ID, last deployed SHA) so the service is stateless.

On PR close, the entire namespace is deleted, cascading to all resources.

## Deploying Previewkit

### Prerequisites

- An EKS cluster with the ingress-nginx controller and a wildcard DNS record `*.{PREVIEW_DOMAIN}` pointing at the shared gateway
- Karpenter (build/preview node pools) and the External Secrets Operator (AWS Secrets Manager integration)
- A GitHub App with `pull_request` and `push` webhook events enabled, pointed at the autonoma API's `/v1/github/webhook` (`push` keeps main-branch environments current)

### Manifests

Kubernetes manifests live under the repo's `deployment/` directory (applied with `kubectl apply`; there is no kustomization):

- `deployment/apps/previewkit.yaml` -- the Previewkit Deployment, Service, RBAC/ServiceAccount, and its ExternalSecret.
- `deployment/previewkit/cluster/` -- one-time cluster bootstrap:
  - `config/` -- `namespace.yaml` (the shared `system` namespace), `storage-class.yaml`, `vpc-cni-network-policy.yaml`
  - `secrets-manager/` -- `cluster-secret-store.yaml` + `service-account.yaml` (External Secrets Operator -> AWS Secrets Manager)
  - `karpenter/` -- `nodepool.yaml`, `nodeclass.yaml`, `nodepool-buildkit.yaml` (dedicated build nodes)
  - `ingress/` -- ingress-nginx values and the shared gateway HTTPRoute

Per-build BuildKit runs as ephemeral Kubernetes Jobs created in-code (`builder/buildkit-job-manager.ts`), not a static daemon manifest.

### Local Development

From the repo root:

```bash
pnpm install
pnpm --filter @autonoma/previewkit dev
```

Requires access to a Kubernetes cluster and at least these env vars (see the table above):

```
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY=...      # base64-encoded PEM
PREVIEW_URL_SECRET=...
```

### Running Tests

```bash
pnpm --filter @autonoma/previewkit test                 # unit tests, no Docker
pnpm --filter @autonoma/previewkit test:integration     # Testcontainers (real Postgres), needs Docker
pnpm --filter @autonoma/previewkit test:kind            # real-apiserver BuildKitJobManager tests, needs kind + Docker
pnpm --filter @autonoma/previewkit typecheck
```

`test:kind` is opt-in: it creates (or reuses) a dedicated local `kind` cluster named
`previewkit-readiness` and drives `BuildKitJobManager` against a real Kubernetes apiserver to validate the
phased readiness timeout. It has a hard safety gate that refuses to run against anything but a local kind
cluster, so it can never touch a real cluster. Remove the cluster with
`kind delete cluster --name previewkit-readiness`.
