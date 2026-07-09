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
  Deploy app containers + Services
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
    connections:
      - key: API_URL
        target: api
        property: url
    health_check: /health

  - name: api
    path: ./apps/api
    port: 4000
    dockerfile: ./apps/api/Dockerfile
    connections:
      - key: DATABASE_URL
        target: db
        property: url
      - key: REDIS_URL
        target: cache
        property: url
    health_check: /health
    # API keys and other typed values live in the app's secret bundle, not here.

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
| `build_secrets` | No | `[]` | Secret keys to also expose at build time as Docker build args (e.g. `NEXT_PUBLIC_*`); each must already exist in the app's secret bundle |
| `connections` | No | `[]` | Non-secret variables wired to another app/service and resolved at deploy time. Each is `{ key, target, property, build_time? }` (e.g. `DATABASE_URL` -> the `db` service's `url`). See [Connections](#connections) |
| `command` | No | | Override the container command |
| `health_check` | No | | HTTP path for readiness/liveness probes |
| `primary` | No | | Marks this app as the environment's primary URL |
| `depends_on` | No | | Names of apps/services this app waits for before starting |
| `resources` | No | | **Ignored for user-authored config.** App containers request 250m CPU / 512Mi memory with a 1Gi memory limit; CPU is never limited, so apps burst freely. The field is still accepted so existing configs validate, but its `cpu`/`memory` values have no effect here - resource sizing is honored only for trusted, platform-authored config. |

**Service fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | | Name used in `{{name.host}}` templates |
| `recipe` | Yes | | One of: `postgres`, `redis`, `valkey`, `temporal`, `mongodb`, `upstash`, `api-gateway`, `docker-image` |
| `version` | No | | Image tag (e.g. `"16"` for `postgres:16`) |
| `options` | No | `{}` | Recipe-specific options (e.g. postgres `user` / `database`, `docker-image`'s `image` / `port` / `readiness`) |
| `resources` | No | | **Ignored for user-authored config** (see app fields). Service containers request 100m CPU / 256Mi memory with a 1Gi memory limit. |

### Connections

Every variable a user types is a secret (stored in AWS Secrets Manager). The one non-secret variable is a **connection**: a value wired to another app or service in the preview namespace and resolved at deploy time. It has no static value, so it is never stored as a secret.

Each connection names an env `key`, the `target` app/service, the `property` to read, and an optional `build_time` flag:

```yaml
connections:
  # DATABASE_URL = the db service's full connection string
  - key: DATABASE_URL
    target: db
    property: url

  # VITE_API_URL = the api app's public URL, also baked into the image build
  - key: VITE_API_URL
    target: api
    property: url
    build_time: true
```

Properties resolve as:
- `host` / `port` - the Kubernetes service DNS name and port within the namespace (e.g. `db`, `api`).
- `url` -
  - an **app**'s public HTTPS preview URL, or
  - a **service**'s in-cluster connection string, when the recipe defines a well-known scheme:
    - `postgres` -> `postgresql://preview:preview@<host>:<port>/preview`
    - `redis` / `valkey` -> `redis://<host>:<port>`
    - `mongodb` -> `mongodb://<host>:<port>/?directConnection=true`

Recipes without a single-scheme URL (e.g. `temporal`, `api-gateway`) expose only `host` / `port`.

A `build_time` connection is also passed as a Docker build arg (for values baked into the image, e.g. a Vite frontend's API URL). At runtime a connection is injected as an env var and wins over a stored secret of the same key.

### Built-in Environment Variables

Every app pod is injected with these at deploy time (`Deployer.deployApp`). The names are reserved - the secrets API rejects uploads using them, and they always override any user-set value (a connection or a stored secret):

| Variable | Value |
| --- | --- |
| `AUTONOMA_PREVIEWKIT` | `true` |
| `AUTONOMA_PREVIEWKIT_PR` | The pull request number (e.g. `123`) |
| `AUTONOMA_PREVIEWKIT_URL` | This app's public URL, `https://{hash}.{domain}` (per-app) |

The reserved key set lives in `@autonoma/types` (`PREVIEWKIT_BUILTIN_ENV_VARS` / `isReservedPreviewkitEnvKey`).

## Secrets Management

Every user-typed variable is a secret. Secrets are stored in AWS Secrets Manager, one bundle per (application, app) under the name `previewkit/{org-slug}/{application}/{app}`, and are never committed to your repository. At deploy time the External Secrets Operator mirrors each bundle into a Kubernetes Secret (`{app}-secrets`) in the preview namespace, which the app Deployment mounts via `envFrom`. Build-time secrets (the keys listed in `build_secrets`) are fetched straight from AWS Secrets Manager and passed as Docker build args.

At deploy time, connections are resolved and injected as pod env, layered on top of the secret bundle. A connection wins over a stored secret of the same key, so it is the override channel for preview-infrastructure wiring while API keys stay in the secret store:

```
Stored secrets (envFrom)  -> { DATABASE_URL: "postgres://prod:5432", OPENAI_API_KEY: "sk-..." }
Connections (env, wins)   -> { DATABASE_URL: "{{db.url}}" }
After resolve             -> { DATABASE_URL: "postgresql://preview:preview@db:5432/preview", OPENAI_API_KEY: "sk-..." }
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
| `BUILDKIT_WARM_HOST` | No | `tcp://buildkit.buildkit.svc.cluster.local:1234` | Service endpoint of the long-lived warm buildkitd pool (`deployment/buildkit/buildkitd-warm.yaml`). With the admission queue on, builds dial the granting pod directly and this host is only the fail-open fallback |
| `BUILD_TIMEOUT_MS` | No | `1800000` | Per-build timeout (30 min); excludes queue wait |
| `BUILDKIT_QUEUE_ENABLED` | No | `true` | Warm-pool admission queue: each build claims a per-pod slot Lease (control-cluster `buildkit` namespace) before running, bounding concurrent builds per buildkitd pod, FIFO across all environments. Fails open to `BUILDKIT_WARM_HOST` when the queue infrastructure is unreachable |
| `BUILDKIT_QUEUE_SLOTS_PER_POD` | No | `2` | Concurrent builds admitted per ready pool pod. Tune together with buildkitd `max-parallelism` and the KEDA threshold (both assume ~2 builds per pod) |
| `BUILDKIT_QUEUE_MAX_WAIT_MS` | No | `1200000` | Max time a build waits for a slot (20 min) before failing with a pool-saturation error |
| `BUILDKIT_QUEUE_POLL_MS` | No | `5000` | Queue poll interval while waiting |
| `INGRESS_NAMESPACE` | No | `system` | Namespace of the shared edge (Gateway, ingress-nginx, and the central Gatekeeper) |
| `GATEKEEPER_IDLE_TIMEOUT` | No | `30m` | Idle duration before the central Gatekeeper scales an env's workloads to zero; written per namespace as the `gatekeeper.dev/idle-timeout` annotation (Go duration string). The Gatekeeper install itself lives in `deployment/previewkit/cluster/gatekeeper/` |
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

Previewkit builds each app with BuildKit (no Docker daemon) against a long-lived warm buildkitd pool (`BUILDKIT_WARM_HOST`), choosing a strategy in this order:

1. **Dockerfile** -- if you set the app's `dockerfile` field, or a `Dockerfile` exists in the app directory, it is built with [BuildKit](https://github.com/moby/buildkit) via `buildctl`. For a multi-stage Dockerfile, set `build.target` (with `build.framework: dockerfile`) to pick the stage to build, like `docker build --target` -- otherwise BuildKit builds the **last** stage, which builds the wrong service when a Dockerfile ends with a worker/sidecar stage after the deployable one.
2. **Turbo monorepo** -- if the app sets `monorepo: turbo`, the build runs from the repo root with a Turbo filter for that app.
3. **Railpack** -- otherwise [Railpack](https://railpack.com) auto-detects the language and framework and builds via BuildKit. Supports Node.js, Go, Python, PHP, Java, Ruby, and more.

All paths push to the configured registry.

**Image tag format:** `{registry}/{owner}/{repo}:{app-name}-pr-{N}-{short-sha}` (e.g. `ghcr.io/my-org/my-repo:api-pr-42-a1b2c3d4`)

## Infrastructure Recipes

Recipes are built-in definitions for common infrastructure services deployed alongside your apps.

| Recipe | Image | Port | Notes |
|--------|-------|------|-------|
| `postgres` | Previewkit's bundled image (broad extension set) | 5432 | StatefulSet with PVC. user/password/db all `preview`. Set `version` for stock `postgres:{version}`, or pin `options.image` (allowed prefixes: `postgres:`, `postgis/postgis:`, `pgvector/pgvector:`, `google/alloydbomni`). Extra databases + extensions, and opt-in TLS via `options.ssl`, configured via `options` (see below) |
| `redis` | `redis:{version}-alpine` | 6379 | Deployment, no persistence. Default version `7-alpine` |
| `valkey` | `valkey/valkey:{version}` | 6379 | Deployment, no persistence. Default version `8-alpine` |
| `mongodb` | `mongo:{version}` | 27017 | StatefulSet with PVC. Single-node replica set (Change Streams); connect with `directConnection=true`. Default version `7` |
| `temporal` | `temporalio/temporal:{version}` | 7233 (gRPC), 8233 (UI) | Deployment, `start-dev` mode |
| `upstash` | `hiett/serverless-redis-http` + `redis` sidecar | 8000 (REST), 6379 (RESP) | Serverless-Redis-HTTP proxy over a Redis sidecar in one Pod. Exposes both the REST port (for `@upstash/redis`/`@vercel/kv` via `KV_REST_API_URL`) and the raw Redis port (for `ioredis`/`KV_URL`), like real Vercel KV. `{{cache.port}}` resolves to the REST port. Default token `local-dev-token` |
| `api-gateway` | `nginx:{version}-alpine` | 80 | Deployment. Routes requests to backend services. Default version `1.27-alpine` |
| `docker-image` | Configured via `options.image` | Configured via `options.port` | Generic recipe for any service; see below |

**Docker Hub mirroring:** every recipe image that resolves to Docker Hub (including a `docker-image` `options.image` like `minio/minio`) is transparently rewritten to pull through the ECR pull-through cache (`DOCKER_HUB_MIRROR`), avoiding Docker Hub rate limits. Images on other registries (`ghcr.io`, ECR, ...) are pulled directly. Images built from your repo are pushed to and pulled from our own registry and are never rewritten.

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
      ssl: true                         # optional: serve TLS (default false) - see below
```

**`ssl`** (default `false`): Postgres ships TLS off, but some apps force SSL whenever the DB host is
not `localhost` (a habit from managed Postgres like Neon / RDS / AlloyDB, e.g.
`ssl: { rejectUnauthorized: false }`). Against a plain preview DB those clients fail the TLS handshake
(`ECONNRESET`) before any query runs. Set `ssl: true` to serve a throwaway self-signed cert and turn
`ssl=on`. This only makes TLS *available* - it never requires it - so plaintext clients are unaffected.
The cert is generated by an init container onto an ephemeral volume each pod start; its content is
irrelevant since such clients connect with `rejectUnauthorized: false` and don't verify it.

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
| `additional_ports` | No | Extra named ports exposed by the Service: `[{ name, port }]` |
| `readiness` | No | Exactly one of `http`, `exec`, `tcp`. Omit for instant readiness |

For `readiness.http` and `readiness.tcp`, the probe port defaults to `options.port` if not set. `readiness` also accepts optional `initial_delay_seconds` and `period_seconds`.

## Kubernetes Resources

Each preview environment gets its own namespace with full isolation:

```
Namespace: preview-{owner}-{repo}-pr-{N}
  ├── StatefulSet + Service + PVC        (per infrastructure service)
  ├── Deployment + Service               (per app; no per-app Ingress)
  ├── Role + RoleBinding                 (central-gatekeeper: the central proxy's workload grant)
  └── Labels: previewkit.dev/managed-by, previewkit.dev/pr-number, previewkit.dev/repo,
              gatekeeper.dev/managed (+ gatekeeper.dev/routes & idle-timeout annotations)
```

Routing is owned by the central Gatekeeper in `system` (one wildcard Ingress for
`*.preview.autonoma.app`); it discovers each namespace by the `gatekeeper.dev/managed`
label and routes by the `gatekeeper.dev/routes` annotation, so no per-app Ingress exists.
Namespace annotations also store state (comment ID, last deployed SHA) so the service is stateless.

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
  - `config/` -- `namespace.yaml` (the shared `system` + `cronjobs` namespaces), `storage-class.yaml`, `vpc-cni-network-policy.yaml`
  - `secrets-manager/` -- `cluster-secret-store.yaml` + `service-account.yaml` (External Secrets Operator -> AWS Secrets Manager)
  - `karpenter/` -- `nodepool.yaml` (default spot pool + gatekeeper pool), `nodeclass.yaml`
  - `ingress/` -- ingress-nginx values and the shared gateway HTTPRoute
  - `gatekeeper/` -- the central Gatekeeper (3-replica leader-elected proxy: sleep/wake + routing for every preview) and its wildcard Ingress, plus `migrate-existing-previews.sh` -- the one-time rollout tool that moves already-running previews off their old per-namespace gatekeepers (dry-run by default; run with `--apply` after applying the manifests, and re-run for stragglers)
  - `logging/` -- `alloy.yaml` (DaemonSet shipping preview pod logs to Loki)
  - `monitoring/` -- `prometheus.yaml` + `opencost.yaml` (per-namespace/per-PR cost attribution; see the file headers for access)
- `deployment/previewkit/cronjobs/delete-old-ns.yaml` -- nightly reaper deleting preview namespaces older than 7 days (main-branch `*-pr-0` environments excluded)

Builds run against the long-lived warm buildkitd pool (`deployment/buildkit/buildkitd-warm.yaml`); each pod's node-local NVMe cache keeps layer reuse hot across builds. Admission is queued (`src/builder/build-queue.ts`): before spawning `buildctl`, each build claims a per-pod slot Lease in the pool's namespace and dials that pod directly, so a burst of pushes waits FIFO (visible as `bkq-*` Leases via `kubectl -n buildkit get leases`, and as "Waiting for a free buildkit build slot" lines in the build log) instead of oversubscribing the daemons into CPU thrash and OOM kills. Slot placement is rendezvous-hashed on the app's cache key for warm-cache affinity. KEDA autoscales the pool between 3 and 8 pods on the in-flight build count (`deployment/buildkit/buildkit-scaledobject.yaml`), which includes queued builds - a growing queue is exactly the scale-up signal, and new pods' slots drain it as soon as they are Ready. The queue needs the `previewkit-build-queue` Role/RoleBinding in the `buildkit` namespace (`deployment/apps/previewkit.yaml`); without it, builds fail open to the shared `BUILDKIT_WARM_HOST` Service with a warning.

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
pnpm --filter @autonoma/previewkit typecheck
```
