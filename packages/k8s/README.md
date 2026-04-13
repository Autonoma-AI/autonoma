# @autonoma/k8s

Lightweight Kubernetes helpers for the Autonoma platform. Provides a `KubeConfig` factory, image resolution from a cluster ConfigMap, and shared type definitions for K8s job orchestration.

> For workflow orchestration, see `packages/workflow` (Temporal-based).

## Exports

| Export | Type | Description |
|--------|------|-------------|
| `makeKubeConfig()` | Function | Creates a `KubeConfig` loaded from the default context (in-cluster or local kubeconfig) |
| `getImage(key)` | Async function | Resolves a container image URI from the `image-version` ConfigMap in the configured namespace |
| `ImageKey` | Type | Union of valid image identifiers (e.g. `"web"`, `"ios"`, `"execution-agent-web"`) |
| `K8sClient` | Interface | Contract for creating, deleting, and querying K8s jobs |
| `K8sJobOptions` | Interface | Options bag for `K8sClient.createJob` - name, namespace, image, env, labels |

## Usage

### Resolve a container image

```ts
import { getImage } from "@autonoma/k8s";

const image = await getImage("execution-agent-web");
// => "us-docker.pkg.dev/autonoma/images/execution-agent-web:abc123"
```

`getImage` reads the `image-version` ConfigMap in the namespace defined by the `NAMESPACE` environment variable, then looks up the key matching the provided `ImageKey`.

### Create a KubeConfig

```ts
import { makeKubeConfig } from "@autonoma/k8s";

const kc = makeKubeConfig();
const api = kc.makeApiClient(CoreV1Api);
```

## Environment Variables

Defined in `src/env.ts` via `@t3-oss/env-core`:

| Variable | Required | Description |
|----------|----------|-------------|
| `NAMESPACE` | Yes | Kubernetes namespace used to read the `image-version` ConfigMap |

## Architecture Notes

- The `image-version` ConfigMap is the single source of truth for which container images are deployed per namespace. Each key maps an `ImageKey` to a fully qualified image URI.
- `makeKubeConfig` uses `loadFromDefault()`, which auto-detects in-cluster service account tokens or falls back to `~/.kube/config` for local development.
- The `K8sClient` interface and `K8sJobOptions` are exported as contracts for Kubernetes operations.
- This package is ESM-only (`"type": "module"`).
