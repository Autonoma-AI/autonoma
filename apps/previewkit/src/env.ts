import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
    server: {
        PORT: z.coerce.number().default(3000),
        LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

        // GitHub App credentials
        GITHUB_APP_ID: z.string().min(1),
        GITHUB_PRIVATE_KEY: z.string().min(1),

        // Container registry
        REGISTRY_URL: z.string().default("registry.previewkit.svc.cluster.local:5000"),

        // BuildKit
        BUILDKIT_HOST: z.string().default("tcp://buildkitd.previewkit.svc.cluster.local:1234"),

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

        // Tenant isolation: namespace of the ingress controller in the preview cluster.
        // Previewkit itself runs in a separate cluster, so it is not referenced here.
        INGRESS_CONTROLLER_NAMESPACE: z.string().default("ingress-nginx"),

        // Comma-separated CIDRs for the ALB subnets so the ALB can reach pods directly
        // in IP mode (AWS Gateway API Controller). Required when network policies are enforced.
        GATEWAY_SUBNET_CIDRS: z.string().default(""),
    },
    runtimeEnv: process.env,
});
