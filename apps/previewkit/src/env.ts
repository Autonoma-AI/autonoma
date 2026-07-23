import { base64PrivateKey } from "@autonoma/github/schemas";
import { env as loggerEnv } from "@autonoma/logger/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const timeoutEnv = (defaultValue: number) =>
    z.preprocess(
        (value) => (typeof value === "string" ? value.replaceAll("_", "") : value),
        z.coerce.number().int().positive().default(defaultValue),
    );

export const env = createEnv({
    extends: [loggerEnv],
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

        // npm/bun package-registry cache (Verdaccio, deployment/buildkit/verdaccio.yaml),
        // proxying registry.npmjs.org from inside the buildkit namespace. Unlike
        // DOCKER_HUB_MIRROR (container image pulls), this covers npm/pnpm/yarn-classic/
        // bun installs run by RUN steps during a build - traffic BuildKit's own
        // registry mirroring never touches. Injected as npm_config_registry /
        // BUN_CONFIG_REGISTRY ENV lines into every generated Dockerfile
        // (GenerateDockerfileContext.npmRegistryMirror) and into every user-authored
        // Dockerfile after each stage's FROM (BuildKitBuilder, injectNpmRegistryMirror).
        // Empty string disables both.
        NPM_REGISTRY_MIRROR: z.string().default("http://verdaccio.buildkit.svc.cluster.local:4873/"),

        // BuildKit: each app-build attempt creates an isolated buildkitd Job in
        // the control cluster. The runner waits for its pod, dials the pod IP,
        // and deletes the Job when the attempt settles. Each Job starts with
        // empty local state, but imports/exports a rolling per-app registry
        // cache (see `buildPreviewCacheReference`) so a cold Job can still
        // reuse a previous build's layers.
        BUILDKIT_BUILD_NAMESPACE: z.string().default("buildkit"),
        BUILDKIT_IMAGE: z
            .string()
            .default("140023360995.dkr.ecr.us-east-1.amazonaws.com/docker-hub/moby/buildkit:v0.31.2"),
        BUILD_TIMEOUT_MS: timeoutEnv(1_800_000), // 30 minutes
        DEPLOY_TIMEOUT_MS: timeoutEnv(600_000), // 10 minutes
        // Karpenter provisioning and buildkitd startup have separate budgets so
        // a cold node launch is not mistaken for a broken daemon.
        BUILD_READINESS_TIMEOUT_MS: timeoutEnv(600_000), // 10 minutes
        BUILD_STARTUP_TIMEOUT_MS: timeoutEnv(180_000), // 3 minutes

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
        AWS_REGION: z.string().min(1).default("us-east-1"),
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

        // Temporal, for the post-deploy diffs trigger. Optional so dev/self-host and any environment without
        // a control-plane Temporal simply no-op the trigger (the runner still deploys the preview). When set,
        // @autonoma/workflow's client reads TEMPORAL_ADDRESS/TEMPORAL_NAMESPACE from process.env directly; these
        // are declared here only so the runner can gate on "is Temporal wired for this environment?". The
        // launcher injects the launching env's values per-Job (like DATABASE_URL) so a beta preview triggers on
        // beta's Temporal, not the shared secret's production one.
        TEMPORAL_ADDRESS: z.string().optional(),
        TEMPORAL_NAMESPACE: z.string().optional(),

        // The serialized {mode, event, ...} payload for a single
        // deploy/teardown run, set by the API's PreviewkitJobLauncher on the
        // runner Job. Present only when this process is a one-shot runner Job
        // (src/runner); the long-lived Temporal worker never reads it. The JSON
        // shape is re-validated at the boundary in src/runner/job-spec.ts.
        PREVIEWKIT_JOB_SPEC: z.string().optional(),
    },
    runtimeEnv: process.env,
});
