# @autonoma/k8s

Kubernetes helpers for the Autonoma platform. Provides a `KubeConfig` factory,
image resolution from a cluster ConfigMap, cross-cluster EKS authentication,
read-only preview power/health liveness derived from workload state, and the
previewkit runner-Job launcher.

> For workflow orchestration, see `packages/workflow` (Temporal-based).

## Subpath exports

The package is split so consumers only load what they need (the `.` entry
validates a required `NAMESPACE` env var; the subpaths do not):

| Import                           | Contents                                                                |
| -------------------------------- | ----------------------------------------------------------------------- |
| `@autonoma/k8s`                  | `makeKubeConfig`, `getImage`, `K8sClient` / `K8sJobOptions` types       |
| `@autonoma/k8s/eks`              | `EksKubeconfigLoader` - cross-cluster EKS auth via STS-presigned tokens |
| `@autonoma/k8s/preview-liveness` | `PreviewFleetClient`, `classifyNamespace`, liveness types               |
| `@autonoma/k8s/previewkit-jobs`  | `PreviewkitJobLauncher`, `previewEnvKey`, the injected K8s seams        |

### `.` - core helpers

| Export             | Type           | Description                                                                                   |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------- |
| `makeKubeConfig()` | Function       | Creates a `KubeConfig` loaded from the default context (in-cluster or local kubeconfig)       |
| `getImage(key)`    | Async function | Resolves a container image URI from the `image-version` ConfigMap in the configured namespace |
| `ImageKey`         | Type           | Union of valid image identifiers (e.g. `"web"`, `"ios"`, `"reviewer"`)                        |
| `K8sClient`        | Interface      | Contract for creating, deleting, and querying K8s jobs                                        |
| `K8sJobOptions`    | Interface      | Options bag for `K8sClient.createJob` - name, namespace, image, env, labels                   |

### `/eks` - cross-cluster auth

`EksKubeconfigLoader(clusterName, region, staticClusterInfo?)` builds a
`KubeConfig` authenticated with a short-lived STS-presigned token (the handshake
`aws eks get-token` performs) so a pod in one cluster can reach another cluster's
API server. Pass `staticClusterInfo` (`{ endpoint, caData }`) to skip
`eks:DescribeCluster`. The token lasts 60s; call `refresh()` on a ~30s timer -
it mutates the returned `KubeConfig` in place, so clients holding the reference
pick up the new token automatically.

### `/preview-liveness` - preview power/health state

`PreviewFleetClient(kubeConfig)` reads every preview's state from the preview
cluster in one round trip (three label-filtered cluster-wide LISTs: Deployments,
StatefulSets, Pods). It is strictly READ-ONLY - it never scales anything, so
reading a preview's state never wakes it, unlike an HTTP probe through the
Gatekeeper.

`listFleet()` returns `Map<namespace, NamespaceLiveness>`, each a
`PreviewPowerState` rolled up from its workloads:

| State     | Meaning                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `asleep`  | Scaled to zero by the Gatekeeper idle loop (its `wake-replicas` annotation is the fingerprint)             |
| `waking`  | Replicas requested but not all Ready yet, no fatal container state - the normal cold-start transient       |
| `healthy` | Every managed workload has its full replica count Ready                                                    |
| `error`   | A workload is broken and will not self-heal (crashloop, image-pull failure, bad config, progress deadline) |

`classifyNamespace(input)` is the pure function behind it - given the workload
and pod objects it always returns the same verdict, which is what the kind
integration suite pins against real API responses.

### `/previewkit-jobs` - the preview runner-Job launcher

`PreviewkitJobLauncher` creates one Kubernetes Job per preview operation
(`launchDeploy` / `launchTeardown` / `launchRedeployApp`), each running
`apps/previewkit`'s one-shot runner. It resolves the SHA-pinned runner image from
the `previewkit-runner-image` ConfigMap in its own namespace, supersedes any
in-flight deploy-family Job for the same `(repo, PR)` (the per-environment mutex
carried on the `previewkit.dev/env` label), and bakes its own `DATABASE_URL` and
`SENTRY_ENV` into the Job so the runner writes to the launching environment's
database.

`launchDeploy` returns the server-assigned Job name, and `cancelDeploy(jobName)`
stops that one Job. The pairing matters: the `previewkit.dev/env` label is per
`(repo, PR)`, so cancelling a superseded build by label would delete whichever
newer commit had already launched. A build is superseded by label and cancelled
by name.

The `PREVIEWKIT_JOB_SPEC` payload it writes is parsed against `previewJobSpecSchema`
(`@autonoma/types`) before serializing - the same definition the runner parses it back
with, so a spec the runner would reject fails at launch rather than inside a Job nobody
is watching.

Its Kubernetes dependencies are two narrow injected seams - `PreviewJobsApi` (a
slice of `BatchV1Api`) and `ConfigMapReader` (a slice of `CoreV1Api`) - which real
clients satisfy structurally, so tests pass lightweight fakes.

Two processes launch these Jobs: the API owns teardown and per-app redeploy, and
the general worker owns the deploy build (it runs the activity that decides,
mid-orchestration, whether a build is worth running). They run as **different**
service accounts - `api` and `worker-general` - so both must be subjects of the
`previewkit-job-launcher-ephemeral` RoleBinding in the `previewkit` namespace and
of the `configmaps: get` grant in their own namespace. A third launching workload
means adding it to both.

Configuration comes from `@autonoma/k8s/previewkit-jobs/env`, which each host
`extends` rather than assembling its own; `getInClusterPreviewkitJobLauncher()`
therefore takes no arguments, and the hosts cannot disagree about which database
a runner writes to or which CMK it unwraps keys with. A host missing one of those
variables fails at boot instead of at its first launch.

## Usage

### Resolve a container image

```ts
import { getImage } from "@autonoma/k8s";

const image = await getImage("reviewer");
// => "us-docker.pkg.dev/autonoma/images/reviewer:abc123"
```

`getImage` reads the `image-version` ConfigMap in the namespace defined by the `NAMESPACE` environment variable, then looks up the key matching the provided `ImageKey`.

### Create a KubeConfig

```ts
import { makeKubeConfig } from "@autonoma/k8s";

const kc = makeKubeConfig();
const api = kc.makeApiClient(CoreV1Api);
```

### Read preview liveness cross-cluster

```ts
import { EksKubeconfigLoader } from "@autonoma/k8s/eks";
import { PreviewFleetClient } from "@autonoma/k8s/preview-liveness";

const loader = new EksKubeconfigLoader("preview-cluster", "us-east-1");
const client = new PreviewFleetClient(await loader.load());

const fleet = await client.listFleet();
fleet.get("preview-acme-web-pr-42")?.state; // "asleep" | "waking" | "healthy" | "error"
```

## Environment Variables

Only the `.` entry reads env (via `@t3-oss/env-core`); `/eks` and
`/preview-liveness` take their configuration as constructor arguments.

| Variable    | Required             | Description                                                     |
| ----------- | -------------------- | --------------------------------------------------------------- |
| `NAMESPACE` | Yes (for `getImage`) | Kubernetes namespace used to read the `image-version` ConfigMap |

## Architecture Notes

- The `image-version` ConfigMap is the single source of truth for which container images are deployed per namespace. Each key maps an `ImageKey` to a fully qualified image URI.
- `makeKubeConfig` uses `loadFromDefault()`, which auto-detects in-cluster service account tokens or falls back to `~/.kube/config` for local development.
- `EksKubeconfigLoader` is used by the previewkit runner (deploying into the preview cluster) and the autonoma API (reading preview liveness) - both reach the preview cluster from outside it.
- Preview liveness is derived from Kubernetes workload state because that is the source of truth the central Gatekeeper itself scales against; it distinguishes a healthy preview from one that woke but is crashlooping, which a proxy's power flag cannot.
- This package is ESM-only (`"type": "module"`).

## Testing

- `pnpm --filter @autonoma/k8s test` - fast, hermetic unit tests (classifier + EKS token caching). No Docker.
- `pnpm --filter @autonoma/k8s test:integration` - runs `PreviewFleetClient` against a **real kind cluster** it creates and tears down, applying fixtures for every state (healthy, asleep, waking, image-pull error, crashloop) and asserting the derived verdicts against actual API responses. Requires `kind`, `kubectl`, and a running Docker daemon. In CI this runs as the `K8s Integration (kind)` job when `packages/k8s/**` changes.
