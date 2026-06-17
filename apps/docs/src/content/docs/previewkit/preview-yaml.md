---
title: .preview.yaml Reference
description: Complete schema for the Previewkit configuration file - apps, services, recipes, environment templating, and post-deploy hooks.
---

The `.preview.yaml` file at the root of your repository tells Previewkit how to build and deploy your stack for each pull request. This page documents every field.

Configs can also be authored from the Autonoma dashboard (PreviewKit onboarding's topology builder) instead of committing a file. A dashboard-saved config is stored as an active revision and takes precedence over the repo's `.preview.yaml`; this applies to multirepo dependency repos too - each dependency repo's dashboard revision is preferred, falling back to that repo's committed file.

## Top-level shape

```yaml
version: 1            # required, must be 1
domain: string?       # optional, override preview hostname suffix
registry: string?     # optional, override image registry

apps: [App]           # required, at least one
services: [Service]   # optional
hooks:
  post_deploy: [Hook] # optional
```

| Field      | Type     | Default                | Notes                                                                        |
|------------|----------|------------------------|------------------------------------------------------------------------------|
| `version`  | `1`      | required               | Schema version. Only `1` is supported today.                                 |
| `domain`   | string   | `preview.autonoma.app` | Overrides the hostname suffix. Wildcard DNS must be configured by the operator. |
| `registry` | string   | platform default       | Container registry to push built images to. Usually leave unset.             |
| `apps`     | list     | required               | One or more applications. Each gets a public HTTPS URL.                      |
| `services` | list     | `[]`                   | Backing services from the recipe catalog (databases, caches, etc.).          |
| `hooks`    | object   | `{}`                   | Lifecycle hooks. Today only `post_deploy` is supported.                      |

## Apps

Each entry under `apps` becomes a Kubernetes Deployment plus a public HTTPS hostname.

```yaml
apps:
  - name: api
    path: ./apps/api
    dockerfile: ./apps/api/Dockerfile   # optional
    build_args:                          # optional
      NODE_VERSION: "20"
    port: 4000
    env:
      DATABASE_URL: "postgresql://preview:preview@{{db.host}}:5432/preview"
    command: "node dist/server.js"      # optional, overrides image CMD
    health_check: /health                # optional
    replicas: 1
```

| Field          | Type                 | Default     | Notes |
|----------------|----------------------|-------------|-------|
| `name`         | string               | required    | Kubernetes-style name (lowercase letters, digits, hyphens). Used as the Kubernetes resource name and as an input to the URL hash. |
| `path`         | string               | `"."`       | Path to the build context, relative to the repo root. |
| `dockerfile`   | string               | autodetect  | Path to a Dockerfile (relative to repo root). If omitted, Previewkit looks for `Dockerfile` inside `path`; if none is found, [Railpack](https://railpack.com) auto-detects the framework. |
| `build_args`   | map<string, string>  | `{}`        | Build-time `--build-arg` values. |
| `port`         | integer              | required    | The container port the app listens on. |
| `env`          | map<string, string>  | `{}`        | Runtime environment variables. Supports [templating](#environment-templating). |
| `command`      | string               | image CMD   | Optional shell command to override the image entrypoint. Wrapped in `/bin/sh -c`. |
| `health_check` | string               | none        | HTTP path for both readiness and liveness probes. |
| `replicas`     | integer              | `1`         | Number of pod replicas. |
| `resources.cpu`    | string           | `"250m"`    | **Ignored in `.preview.yaml`** (see note below). CPU request (no limit). |
| `resources.memory` | string           | `"256Mi"`   | **Ignored in `.preview.yaml`** (see note below). Memory request and limit. |

### Resulting URL

Each app gets an opaque URL whose subdomain is a short deterministic hash of the service name, PR number, and repo. For example:

```
https://a3f8b21c4d9e.preview.autonoma.app
```

The hash is stable — the same app/PR/repo always produces the same URL — but does not expose any of those values in the address.

## Services

Services come from a curated recipe catalog. You don't write Kubernetes manifests — you pick a recipe and Previewkit handles everything (Deployment, Service, persistent volume, readiness probes).

```yaml
services:
  - name: db
    recipe: postgres
    version: "16"
    env:
      POSTGRES_DB: app
```

| Field       | Type                | Default         | Notes |
|-------------|---------------------|-----------------|-------|
| `name`      | string              | required        | Used by other apps to address this service (`{{<name>.host}}`). |
| `recipe`    | string              | required        | One of the recipes listed below. |
| `version`   | string              | recipe default  | Image tag for the underlying service. |
| `env`       | map<string, string> | `{}`            | Extra environment variables for the service container. |
| `options`   | map                 | `{}`            | Recipe-specific config. See each recipe below. |
| `resources` | object              | `100m / 256Mi`  | **Ignored in `.preview.yaml`** (see note below). Same shape as app resources. |

:::note[Resource sizing is platform-controlled]
A `resources:` block in a `.preview.yaml` is accepted (so existing configs keep
validating) but has no effect: every app container gets 250m CPU / 512Mi memory
and every service container gets 100m CPU / 256Mi memory, each with a 1Gi memory
limit and no CPU limit (so containers burst freely). Custom resource sizing is
honored only for platform-authored server-side config revisions, not for a
repo's `.preview.yaml`.
:::

### Available recipes

| Recipe        | Default version | Port  | Notes |
|---------------|-----------------|-------|-------|
| `postgres`    | `16-alpine`     | 5432  | Persistent volume attached. Connection: `postgresql://preview:preview@{{name.host}}:5432/preview`. |
| `redis`       | `7-alpine`      | 6379  | No persistence. Connection: `redis://{{name.host}}:6379`. |
| `valkey`      | `7-alpine`      | 6379  | Open-source Redis fork. Same connection shape. |
| `temporal`    | (recipe-default)| 7233  | Local Temporal cluster for workflow testing. |
| `api-gateway` | `1.27-alpine`   | 80    | Nginx-based router that fans requests to multiple apps. Requires `options.routes`. |

#### `api-gateway` options

```yaml
services:
  - name: gateway
    recipe: api-gateway
    options:
      client_max_body_size: 25m
      routes:
        - path: /api
          target: api
          strip_prefix: true
        - path: /
          target: web
```

Each route has `path` (URL prefix to match), `target` (app or service name to forward to), `strip_prefix` (boolean), and `rewrite` (optional path rewrite).

## Hooks

```yaml
hooks:
  post_deploy:
    - app: api
      command: "npx prisma migrate deploy"
    - app: api
      command: "node scripts/seed.js"
```

`post_deploy` runs after every app is deployed and at least one pod for the target app is `Running`. Each step is executed via the Kubernetes API exec subresource (no `kubectl` needed), wrapped in `/bin/sh -c`. Steps run sequentially; the first failure aborts the rest.

| Field     | Type   | Notes |
|-----------|--------|-------|
| `app`     | string | Name of an app declared in `apps`. The hook runs inside its pod. |
| `command` | string | Shell command to execute. |

## Environment templating

The `env` map on apps (and on services) supports two kinds of placeholders that resolve at deploy time:

### Service references

`{{<name>.host}}` and `{{<name>.port}}` resolve to the in-namespace DNS name and port of another app or service.

```yaml
apps:
  - name: web
    env:
      API_URL: "http://{{api.host}}:{{api.port}}"

  - name: api
    env:
      DATABASE_URL: "postgresql://preview:preview@{{db.host}}:5432/preview"
      REDIS_URL: "redis://{{cache.host}}:{{cache.port}}"

services:
  - name: db
    recipe: postgres
  - name: cache
    recipe: redis
```

`{{name.host}}` is always the bare service name (in-cluster DNS). `{{name.port}}` is the recipe's known port for services, or the declared `port` for apps.

Unknown names raise a deploy error with the list of valid names.

### Context variables

Three variables describe the current PR context:

| Variable        | Value                                          |
|-----------------|------------------------------------------------|
| `{{pr}}`        | PR number (e.g. `42`)                          |
| `{{namespace}}` | Kubernetes namespace (`preview-<owner>-<repo>-pr-<N>`) |
| `{{owner}}`     | Repo owner (e.g. `acme-corp`)                  |

```yaml
apps:
  - name: api
    env:
      ENV_LABEL: "pr-{{pr}}-{{owner}}"
      S3_PREFIX: "previews/{{namespace}}/"
```

## Full example

```yaml
version: 1

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
    dockerfile: ./apps/api/Dockerfile
    port: 4000
    env:
      DATABASE_URL: "postgresql://preview:preview@{{db.host}}:5432/preview"
      REDIS_URL: "redis://{{cache.host}}:6379"
      ENV_LABEL: "pr-{{pr}}"
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

## Validation tips

- Names must match `^[a-z0-9][a-z0-9-]*[a-z0-9]$` (Kubernetes-compatible).
- At least one `app` is required.
- `version` must be exactly `1`.
- Service references in `env` must match a name declared elsewhere in the same file.
- Hostnames combine `<app>-pr-<N>-<repo-slug>` and must stay under 63 characters — keep app names short.
