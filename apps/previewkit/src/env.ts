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

        // Preview domain — wildcard DNS must point to ingress controller
        PREVIEW_DOMAIN: z.string().default("preview.example.com"),

        // Kubernetes — empty means use in-cluster config
        KUBECONFIG: z.string().optional(),

        // EKS cross-cluster: if set, Previewkit authenticates to this EKS cluster
        // via AWS SDK (STS-presigned GetCallerIdentity) instead of KUBECONFIG / in-cluster.
        // Requires the pod's IRSA role to have eks:DescribeCluster on the target cluster
        // and an EKS Access Entry mapping the role to K8s RBAC.
        EKS_CLUSTER_NAME: z.string().optional(),
        AWS_REGION: z.string().optional(),
    },
    runtimeEnv: process.env,
});
