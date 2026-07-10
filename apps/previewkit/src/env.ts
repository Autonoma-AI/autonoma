import { base64PrivateKey } from "@autonoma/github/schemas";
import { env as loggerEnv } from "@autonoma/logger/env";
import { env as storageEnv } from "@autonoma/storage/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const timeoutEnv = (defaultValue: number) =>
    z.preprocess(
        (value) => (typeof value === "string" ? value.replaceAll("_", "") : value),
        z.coerce.number().int().positive().default(defaultValue),
    );

export const env = createEnv({
    extends: [storageEnv, loggerEnv],
    server: {
        LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

        // Grafana Loki - the build-log tier. The build pipeline publishes log +
        // phase + status events here keyed by namespace (LokiBuildLogSink); the
        // autonoma API reads them back (LokiLogStore) and relays to the browser
        // over SSE. Optional: when unset, build-log publishing is disabled and
        // build output exists only in the pod-local temp file for the duration
        // of the build.
        LOKI_URL: z.string().url().optional(),

        // GitHub App credentials. The private key is supplied as base64-encoded PEM
        // and decoded at boot.
        GITHUB_APP_ID: z.string().min(1),
        GITHUB_PRIVATE_KEY: base64PrivateKey,

        // Container registry
        REGISTRY_URL: z.string().default("registry.previewkit.svc.cluster.local:5000"),

        // ECR pull-through cache for Docker Hub. Every platform-managed (non-client)
        // image reference that resolves to Docker Hub - service recipes and the nginx
        // access proxy - is rewritten to pull through this prefix
        // (no trailing slash), avoiding Docker Hub rate limits. Official images get
        // the `library/` namespace the cache path requires (postgres:16 ->
        // {mirror}/library/postgres:16). References to other registries are never
        // rewritten. Set to an empty string to disable mirroring.
        DOCKER_HUB_MIRROR: z.string().default("140023360995.dkr.ecr.us-east-1.amazonaws.com/docker-hub"),

        // BuildKit: every build dials the long-lived warm buildkitd pool
        // (deployment/buildkit/buildkitd-warm.yaml) at this endpoint. The pool
        // runs in the control cluster (the same one the runner Job runs in) and
        // is reached by in-cluster DNS; its node-local layer cache (on the
        // pool pod's NVMe) stays hot across builds and is the only build
        // cache - there is no S3 import/export, so a build landing on a cold
        // node just rebuilds from scratch and warms that node's disk.
        BUILDKIT_WARM_HOST: z.string().default("tcp://buildkit.buildkit.svc.cluster.local:1234"),
        BUILD_TIMEOUT_MS: timeoutEnv(1_800_000), // 30 minutes
        DEPLOY_TIMEOUT_MS: timeoutEnv(600_000), // 10 minutes

        // Warm-pool admission queue (builder/build-queue.ts). Every build first
        // claims a per-pod slot Lease in the control cluster's `buildkit`
        // namespace, bounding concurrent builds per buildkitd pod instead of
        // letting a burst of runner Jobs scatter unbounded sessions across the
        // pool (CPU thrash + daemon OOM). Fails open when the queue
        // infrastructure is unreachable, so it can never block all builds.
        BUILDKIT_QUEUE_ENABLED: z
            .enum(["true", "false"])
            .default("true")
            .transform((value) => value === "true"),
        // Concurrent builds admitted per ready pool pod. Tune together with the
        // daemon's max-parallelism (deployment/buildkit/buildkitd-config.yaml)
        // and the KEDA threshold (deployment/buildkit/buildkit-scaledobject.yaml);
        // all three assume ~2 builds per pod.
        BUILDKIT_QUEUE_SLOTS_PER_POD: z.coerce.number().int().positive().default(2),
        // Give up queueing after this long and fail the build with a clear
        // pool-saturation error. Sized so KEDA + Karpenter (2-4 min per node,
        // up to 4 nodes/min) can absorb a burst well within the wait.
        BUILDKIT_QUEUE_MAX_WAIT_MS: timeoutEnv(1_200_000), // 20 minutes
        BUILDKIT_QUEUE_POLL_MS: timeoutEnv(5_000),

        // Preview domain. Wildcard DNS must point to the shared Gateway's ALB.
        // ACM wildcard certs only match a single leftmost label; hostnames are
        // a 12-char HMAC-SHA256 hex label keyed on PREVIEW_URL_SECRET.
        PREVIEW_DOMAIN: z.string().default("preview.autonoma.app"),

        // HMAC key for preview URL generation. Makes hostnames deterministic
        // per (app, PR, repo) but unguessable without this secret.
        PREVIEW_URL_SECRET: z.string().min(1),

        // Namespace of the shared edge: the ALB Gateway, ingress-nginx, AND the
        // central Gatekeeper all live here. Preview routing is one static
        // wildcard chain (ALB HTTPRoute -> ingress-nginx wildcard Ingress ->
        // Gatekeeper, which fans out by Host from each preview namespace's
        // routes annotation), so nothing per-preview ever touches the ALB's
        // 100-rule / 100-target-group quotas. Doubles as the NetworkPolicy
        // ingress source preview pods must accept traffic from.
        INGRESS_NAMESPACE: z.string().default("system"),

        // Kubernetes. Empty means use in-cluster config.
        KUBECONFIG: z.string().optional(),

        // EKS cross-cluster: if set, Previewkit authenticates to this EKS cluster
        // via AWS SDK (STS-presigned GetCallerIdentity) instead of KUBECONFIG / in-cluster.
        // EKS_CLUSTER_ENDPOINT and EKS_CLUSTER_CA skip the eks:DescribeCluster API call,
        // which is required when the cluster lives in a different AWS account.
        EKS_CLUSTER_NAME: z.string().optional(),
        AWS_REGION: z.string().optional(),
        EKS_CLUSTER_ENDPOINT: z.string().url().optional(),
        EKS_CLUSTER_CA: z.string().optional(),

        // External Secrets Operator: name of the ClusterSecretStore that points to AWS Secrets Manager.
        // Required only when AWS secret registrations are present for any organization.
        CLUSTER_SECRET_STORE_NAME: z.string().default("aws-secretsmanager"),

        // How long a preview environment may sit with no requests before the
        // central Gatekeeper (deployment/previewkit/cluster/gatekeeper/) scales
        // its workloads to zero. Written per namespace as the
        // gatekeeper.dev/idle-timeout annotation, so it applies on the next
        // deploy without touching the central install. Go duration string
        // (e.g. "30m", "1h"); "0" disables auto-sleep for new deploys.
        GATEKEEPER_IDLE_TIMEOUT: z.string().default("30m"),
        APP_URL: z.string().url().default("https://beta.autonoma.app"),
        GITHUB_COMMENT_ASSET_BASE_URL: z.string().url().optional(),
        // AES-256-GCM key (64 hex chars / 32 bytes) used to encrypt bypass tokens
        // before they are written to the database. Must match PREVIEWKIT_BYPASS_TOKEN_KEY in the API.
        BYPASS_TOKEN_KEY: z.string().min(64).optional(),

        // The serialized {mode, event, ...} payload for a single
        // deploy/teardown run, set by the API's PreviewkitJobLauncher on the
        // runner Job. Present only when this process is a one-shot runner Job
        // (src/runner); the long-lived Temporal worker never reads it. The JSON
        // shape is re-validated at the boundary in src/runner/job-spec.ts.
        PREVIEWKIT_JOB_SPEC: z.string().optional(),
    },
    runtimeEnv: process.env,
});
