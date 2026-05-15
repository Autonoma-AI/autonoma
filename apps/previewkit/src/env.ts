import { base64PrivateKey } from "@autonoma/github/schemas";
import { env as storageEnv } from "@autonoma/storage/env";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    extends: [storageEnv],
    server: {
        PORT: z.coerce.number().default(3000),
        LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

        // GitHub App credentials. The private key is supplied as base64-encoded PEM
        // and decoded at boot.
        GITHUB_APP_ID: z.string().min(1),
        GITHUB_PRIVATE_KEY: base64PrivateKey,

        // Container registry
        REGISTRY_URL: z.string().default("registry.previewkit.svc.cluster.local:5000"),

        // BuildKit
        BUILDKIT_HOST: z.string().default("tcp://buildkitd.previewkit.svc.cluster.local:1234"),
        BUILD_TIMEOUT_MS: z.coerce.number().default(1_800_000), // 30 minutes

        // Preview domain. Wildcard DNS must point to the shared Gateway's ALB.
        // ACM wildcard certs only match a single leftmost label, so hostnames
        // are flattened to `{app}-pr-{N}-{slug}.{PREVIEW_DOMAIN}`.
        PREVIEW_DOMAIN: z.string().default("preview.autonoma.app"),

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
    },
    runtimeEnv: process.env,
});
