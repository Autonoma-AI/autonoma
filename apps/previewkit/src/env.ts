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

        // BuildKit: a fresh buildkitd Job is spawned per build in
        // BUILDKIT_BUILD_NAMESPACE using BUILDKIT_IMAGE. The Job runs in
        // the control cluster (the same one the runner Job runs in); the runner
        // connects to it by in-cluster DNS, so no static endpoint is configured.
        // Defaults to `buildkit` - the dedicated build namespace (the runner
        // Jobs live in `previewkit`, the buildkitd Jobs here). The buildkitd SA
        // and the `buildkitd-config` ConfigMap the Jobs mount both live in this
        // namespace (deployment/apps/previewkit.yaml).
        //
        // BUILDKIT_BUILDER_SERVICE_ACCOUNT is the SA each build pod runs as. It
        // needs IRSA for the S3 cache bucket and lives in the same namespace as
        // the Jobs. The default "buildkitd" matches the SA in previewkit.yaml.
        BUILDKIT_BUILD_NAMESPACE: z.string().default("buildkit"),
        BUILDKIT_IMAGE: z.string().default("moby/buildkit:v0.21.1"),
        BUILDKIT_BUILDER_SERVICE_ACCOUNT: z.string().default("buildkitd"),
        // Phase-1 warm-builder spike. When set to a buildkitd endpoint
        // (e.g. tcp://pk-buildkit-warm.buildkit.svc.cluster.local:1234) every
        // build dials this single long-lived daemon instead of provisioning an
        // ephemeral Job per build, so its node-local layer cache stays hot
        // across builds and the slow S3 cache import/export drops off the hot
        // path. Unset -> current per-build ephemeral Job behavior.
        BUILDKIT_WARM_HOST: z.string().optional(),
        BUILD_TIMEOUT_MS: timeoutEnv(1_800_000), // 30 minutes
        DEPLOY_TIMEOUT_MS: timeoutEnv(600_000), // 10 minutes
        // Provisioning budget: how long to wait for a freshly-created buildkit
        // Job's pod to be scheduled onto a node (PodScheduled=True) before
        // giving up on that attempt. This bounds pure infra latency - Karpenter
        // launching and registering a fresh buildkit node, which on a cold spot
        // launch routinely takes several minutes. Set generously so a build
        // survives a scale-up instead of failing the whole environment under load.
        BUILD_READINESS_TIMEOUT_MS: timeoutEnv(600_000), // 10 minutes
        // Startup budget: once the pod is scheduled, how long to wait for it to
        // become Ready (image pull + container start + buildkitd boot). Every
        // Karpenter scale-up gives a fresh node with no cached image, so a real
        // moby/buildkit pull happens here - 3 minutes is deliberate so a normal
        // pull plus boot does not flap. A scheduled-but-never-Ready pod is a real
        // "buildkitd is broken" signal, so this is tighter than the provision budget.
        BUILD_STARTUP_TIMEOUT_MS: timeoutEnv(180_000), // 3 minutes

        // Preview domain. Wildcard DNS must point to the shared Gateway's ALB.
        // ACM wildcard certs only match a single leftmost label; hostnames are
        // a 12-char HMAC-SHA256 hex label keyed on PREVIEW_URL_SECRET.
        PREVIEW_DOMAIN: z.string().default("preview.autonoma.app"),

        // HMAC key for preview URL generation. Makes hostnames deterministic
        // per (app, PR, repo) but unguessable without this secret.
        PREVIEW_URL_SECRET: z.string().min(1),

        // Shared in-cluster ingress controller. Every preview gets a plain Ingress
        // with this class; ingress-nginx (running in INGRESS_NAMESPACE) fans out by
        // Host header. The shared ALB Gateway forwards *.preview.autonoma.app to this
        // controller through a single static HTTPRoute, so per-preview routing never
        // touches the ALB's per-load-balancer 100-rule / 100-target-group quotas.
        // INGRESS_NAMESPACE doubles as the NetworkPolicy ingress source for preview
        // pods; it shares the Gateway's `system` namespace so both live together.
        INGRESS_CLASS_NAME: z.string().default("nginx"),
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

        // Gatekeeper image: the per-namespace auth + scale-to-zero proxy deployed
        // into every preview namespace (replaces the old stock-nginx proxy). Built
        // and published by the standalone gatekeeper repo.
        GATEKEEPER_IMAGE: z.string().default("public.ecr.aws/autonoma/gatekeeper:latest"),
        // How long a preview environment may sit with no requests before Gatekeeper
        // scales all its workloads to zero. Go duration string (e.g. "30m", "1h").
        GATEKEEPER_IDLE_TIMEOUT: z.string().default("30m"),
        APP_URL: z.string().url().default("https://beta.autonoma.app"),
        GITHUB_COMMENT_ASSET_BASE_URL: z.string().url().optional(),
        // AES-256-GCM key (64 hex chars / 32 bytes) used to encrypt bypass tokens
        // before they are written to the database. Must match PREVIEWKIT_BYPASS_TOKEN_KEY in the API.
        BYPASS_TOKEN_KEY: z.string().min(64).optional(),

        // The serialized {mode, event, configRevisionId} payload for a single
        // deploy/teardown run, set by the API's PreviewkitJobLauncher on the
        // runner Job. Present only when this process is a one-shot runner Job
        // (src/runner); the long-lived Temporal worker never reads it. The JSON
        // shape is re-validated at the boundary in src/runner/job-spec.ts.
        PREVIEWKIT_JOB_SPEC: z.string().optional(),
    },
    runtimeEnv: process.env,
});
