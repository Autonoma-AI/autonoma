import { base64PrivateKey } from "@autonoma/github/schemas";
import { env as loggerEnv } from "@autonoma/logger/env";
import { env as storageEnv } from "@autonoma/storage/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [storageEnv, loggerEnv],
    server: {
        PORT: z.coerce.number().default(3000),
        LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

        // GitHub App credentials. The private key is supplied as base64-encoded PEM
        // and decoded at boot.
        GITHUB_APP_ID: z.string().min(1),
        GITHUB_PRIVATE_KEY: base64PrivateKey,

        // Container registry
        REGISTRY_URL: z.string().default("registry.previewkit.svc.cluster.local:5000"),

        // BuildKit: a fresh buildkitd Job is spawned per build in
        // BUILDKIT_BUILD_NAMESPACE using BUILDKIT_IMAGE. The Job runs in
        // the same cluster as previewkit; previewkit connects to it by
        // in-cluster DNS, so no static endpoint is configured here.
        //
        // BUILDKIT_BUILDER_SERVICE_ACCOUNT is the SA each build pod runs
        // as. It needs IRSA for the S3 cache bucket and lives in the same
        // namespace as the Jobs. The default "buildkitd" matches the SA
        // in deployment/previewkit/builds-namespace.yaml; override if your
        // cluster uses a different name.
        BUILDKIT_BUILD_NAMESPACE: z.string().default("buildkit"),
        BUILDKIT_IMAGE: z.string().default("moby/buildkit:v0.21.1"),
        BUILDKIT_BUILDER_SERVICE_ACCOUNT: z.string().default("buildkitd"),
        BUILD_TIMEOUT_MS: z.coerce.number().default(1_800_000), // 30 minutes

        // Preview domain. Wildcard DNS must point to the shared Gateway's ALB.
        // ACM wildcard certs only match a single leftmost label; hostnames are
        // a 12-char HMAC-SHA256 hex label keyed on PREVIEW_URL_SECRET.
        PREVIEW_DOMAIN: z.string().default("preview.autonoma.app"),

        // HMAC key for preview URL generation. Makes hostnames deterministic
        // per (app, PR, repo) but unguessable without this secret.
        PREVIEW_URL_SECRET: z.string().min(1),

        // Shared Gateway that every HTTPRoute attaches to. One Gateway = one ALB
        // for the whole cluster; routes come and go with per-PR namespaces.
        GATEWAY_NAME: z.string().default("gateway"),
        GATEWAY_NAMESPACE: z.string().default("system"),
        GATEWAY_LISTENER: z.string().default("https"),

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

        // Comma-separated CIDRs for the ALB subnets so the ALB can reach pods directly
        // in IP mode (AWS Gateway API Controller). Required when network policies are enforced.
        GATEWAY_SUBNET_CIDRS: z.string().default(""),

        // External Secrets Operator: name of the ClusterSecretStore that points to AWS Secrets Manager.
        // Required only when AWS secret registrations are present for any organization.
        CLUSTER_SECRET_STORE_NAME: z.string().default("aws-secretsmanager"),

        // nginx auth proxy image. Each preview namespace gets an nginx deployment
        // that gates access via bypass token header or pk_session cookie.
        // The config is injected via ConfigMap so the default plain nginx:alpine works.
        NGINX_IMAGE: z.string().default("nginx:alpine"),
        APP_URL: z.string().url().default("https://app.autonoma.app"),
        AUTONOMA_SERVICE_SECRET: z.string().min(1).optional(),
        // AES-256-GCM key (64 hex chars / 32 bytes) used to encrypt bypass tokens
        // before they are written to the database. Must match PREVIEWKIT_BYPASS_TOKEN_KEY in the API.
        BYPASS_TOKEN_KEY: z.string().min(64).optional(),
    },
    runtimeEnv: process.env,
});
