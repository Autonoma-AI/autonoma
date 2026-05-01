# Previewkit

Preview environments for pull requests. Deploy any stack to Kubernetes without changing your code.

Previewkit listens for Git provider webhooks, builds container images from your repo, deploys them alongside infrastructure services (Postgres, Redis, etc.) to an isolated Kubernetes namespace, and posts the preview URL back to your PR.

## How It Works

```
PR opened/updated
      |
      v
  Webhook received (/webhooks/github)
      |
      v
  Read .preview.yaml from repo
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
  Load per-app secrets, merge with .preview.yaml env, resolve templates
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

## Config: `.preview.yaml`

Add a `.preview.yaml` to your repository root:

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
| `hooks` | No | Lifecycle hooks |

**App fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | | Lowercase alphanumeric + hyphens. Used in K8s resource names and URLs |
| `path` | No | `.` | Path to the app directory relative to repo root |
| `port` | Yes | | Port the app listens on |
| `dockerfile` | No | | Path to Dockerfile relative to repo root. If absent, Railpack auto-detects |
| `build_args` | No | `{}` | Docker build arguments |
| `env` | No | `{}` | Environment variables. Supports `{{name.host}}` and `{{name.port}}` templates |
| `command` | No | | Override the container command |
| `health_check` | No | | HTTP path for readiness/liveness probes |
| `replicas` | No | `1` | Number of pod replicas |
| `resources.cpu` | No | `250m` | CPU request |
| `resources.memory` | No | `256Mi` | Memory request and limit |

**Service fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | | Name used in `{{name.host}}` templates |
| `recipe` | Yes | | One of: `postgres`, `redis` |
| `version` | No | | Image tag (e.g. `"16"` for `postgres:16`) |
| `env` | No | `{}` | Extra environment variables for the service container |
| `resources.cpu` | No | `250m` | CPU request |
| `resources.memory` | No | `256Mi` | Memory request and limit |

### Template Syntax

Use `{{name.host}}` and `{{name.port}}` in `env` values to reference other apps or services within the preview namespace:

```yaml
env:
  # Reference a service
  DATABASE_URL: "postgresql://preview:preview@{{db.host}}:{{db.port}}/preview"

  # Reference another app
  API_URL: "http://{{api.host}}:{{api.port}}"
```

Templates resolve to Kubernetes service DNS names within the namespace (e.g. `db`, `api`).

## Secrets Management

Secrets are stored as Kubernetes Secrets in the `previewkit` namespace, scoped per owner and app. They are never committed to your repository.

At deploy time, secrets are merged with `.preview.yaml` env vars. The config file takes priority, allowing you to override connection strings for preview infrastructure while keeping API keys in the secret store:

```
Stored secrets (base)       -> { DATABASE_URL: "postgres://prod:5432", OPENAI_API_KEY: "sk-..." }
.preview.yaml env (override) -> { DATABASE_URL: "postgresql://preview:preview@{{db.host}}:5432/preview" }
After merge + resolve       -> { DATABASE_URL: "postgresql://preview:preview@db:5432/preview", OPENAI_API_KEY: "sk-..." }
```

### API Routes

#### Secrets

```
GET    /api/secrets/:owner/:app            List secret keys (values are not exposed)
PUT    /api/secrets/:owner/:app/:key       Save a secret
DELETE /api/secrets/:owner/:app/:key       Delete a secret
```

**Save a secret:**

```bash
curl -X PUT https://previewkit.example.com/api/secrets/acme-corp/api/OPENAI_API_KEY \
  -H "Content-Type: application/json" \
  -d '{"value": "sk-..."}'
```

**List secret keys:**

```bash
curl https://previewkit.example.com/api/secrets/acme-corp/api
# {"owner":"acme-corp","app":"api","keys":["OPENAI_API_KEY","STRIPE_KEY"]}
```

**Delete a secret:**

```bash
curl -X DELETE https://previewkit.example.com/api/secrets/acme-corp/api/STRIPE_KEY
```

Secrets are stored in K8s Secrets named `previewkit-secrets-{owner}-{app}`. Each app gets its own secret — the `api` container never sees `web` secrets and vice versa.

#### Webhooks

```
POST   /webhooks/:provider                Receive Git provider webhooks
```

Configure your GitHub App to send `pull_request` events to `https://previewkit.example.com/webhooks/github`.

#### Health

```
GET    /health                            Health check
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | HTTP server port |
| `LOG_LEVEL` | No | `info` | Log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| `GITHUB_APP_ID` | Yes | | GitHub App ID |
| `GITHUB_PRIVATE_KEY` | Yes | | GitHub App private key (PEM format) |
| `GITHUB_WEBHOOK_SECRET` | Yes | | GitHub webhook secret for signature verification |
| `REGISTRY_URL` | No | `registry.previewkit.svc.cluster.local:5000` | Container image registry |
| `BUILDKIT_HOST` | No | `tcp://buildkitd.previewkit.svc.cluster.local:1234` | BuildKit daemon address |
| `PREVIEW_DOMAIN` | No | `preview.example.com` | Base domain for preview URLs |
| `KUBECONFIG` | No | | Path to kubeconfig file. If unset, uses in-cluster config |

## Preview URL Format

Each app in a preview gets its own URL:

```
https://pr-{N}.{app-name}.{PREVIEW_DOMAIN}
```

For example, PR #42 with apps `web` and `api`:

```
https://pr-42.web.preview.example.com
https://pr-42.api.preview.example.com
```

Requires a wildcard DNS record `*.preview.example.com` pointing to your ingress controller.

## Building Images

Previewkit supports two modes:

1. **Dockerfile** -- if your app has a `Dockerfile` (or you specify one via the `dockerfile` field), it is built with [BuildKit](https://github.com/moby/buildkit) via `buildctl`.
2. **Railpack** -- if no Dockerfile exists, [Railpack](https://railpack.com) auto-detects the language and framework, then builds directly via BuildKit LLB. Supports Node.js, Go, Python, PHP, Java, Ruby, and more.

Both paths use BuildKit (rootless, no Docker daemon required) and push to the configured registry.

**Image tag format:** `{registry}/{owner}/{app-name}:pr-{N}-{short-sha}`

## Infrastructure Recipes

Recipes are built-in definitions for common infrastructure services deployed alongside your apps.

| Recipe | Image | Port | Notes |
|--------|-------|------|-------|
| `postgres` | `postgres:{version}-alpine` | 5432 | StatefulSet with PVC. Default user/password/db: `preview` |
| `redis` | `redis:{version}-alpine` | 6379 | Deployment, no persistence |

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

- Kubernetes cluster with an ingress controller
- Wildcard DNS record `*.preview.example.com` pointing to the ingress controller
- A GitHub App with `pull_request` webhook events enabled
- BuildKit daemon running in the cluster

### Install

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/buildkitd.yaml
kubectl apply -f k8s/previewkit.yaml    # Edit secrets and domain first
```

The `k8s/` directory contains manifests for:

- `namespace.yaml` -- the `previewkit` namespace
- `buildkitd.yaml` -- BuildKit daemon (rootless)
- `previewkit.yaml` -- ServiceAccount, RBAC, Secret, Deployment, Service

### Local Development

```bash
npm install
npm run dev
```

Requires a local Kubernetes cluster (minikube, kind, Docker Desktop) and the following env vars set:

```
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY=...
GITHUB_WEBHOOK_SECRET=...
```

### Running Tests

```bash
npm test
```
