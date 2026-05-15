import { S3Storage } from "@autonoma/storage";
import { serve } from "@hono/node-server";
import * as k8s from "@kubernetes/client-node";
import { createApp } from "./app";
import { BuildKitBuilder } from "./builder/buildkit-builder";
import { Deployer } from "./deployer/deployer";
import { EksKubeconfigLoader } from "./deployer/eks-kubeconfig";
import { env } from "./env";
import { GitHubProvider } from "./git-provider/github-provider";
import { logger } from "./logger";
import { PreviewPipeline } from "./pipeline/preview-pipeline";
import { TeardownPipeline } from "./pipeline/teardown-pipeline";
import { AwsExternalSecretManager } from "./secrets/aws-external-secret-manager";
import { SecretStore } from "./secrets/secret-store";

// Kubernetes client
let kc: k8s.KubeConfig;
if (env.EKS_CLUSTER_NAME != null) {
    if (env.AWS_REGION == null) {
        throw new Error("AWS_REGION is required when EKS_CLUSTER_NAME is set");
    }
    const staticClusterInfo =
        env.EKS_CLUSTER_ENDPOINT != null && env.EKS_CLUSTER_CA != null
            ? { endpoint: env.EKS_CLUSTER_ENDPOINT, caData: env.EKS_CLUSTER_CA }
            : undefined;
    const loader = new EksKubeconfigLoader(env.EKS_CLUSTER_NAME, env.AWS_REGION, staticClusterInfo);
    kc = await loader.load();
    // Refresh the token every 45 seconds (STS presigned URLs expire in 60s).
    // load() mutates the existing kc object in-place, so all API clients pick up the new token.
    setInterval(() => {
        loader.load().catch((err) => logger.error("Failed to refresh EKS kubeconfig token", err));
    }, 45_000);
} else {
    kc = new k8s.KubeConfig();
    if (env.KUBECONFIG) {
        kc.loadFromFile(env.KUBECONFIG);
    } else {
        kc.loadFromDefault();
    }
}

// Git provider
const githubProvider = new GitHubProvider({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
});

// Object storage for build logs. Reads S3_* env from @autonoma/storage/env.
const storage = S3Storage.createFromEnv();

// Builder. The BuildKit layer cache shares the storage bucket with build logs;
// each writes under a distinct top-level key prefix so they can coexist.
const builder = new BuildKitBuilder({
    buildkitHost: env.BUILDKIT_HOST,
    buildTimeoutMs: env.BUILD_TIMEOUT_MS,
    storage,
});

const gatewaySubnetCidrs = env.GATEWAY_SUBNET_CIDRS
    ? env.GATEWAY_SUBNET_CIDRS.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
    : [];

// Secret store (K8s Secrets in the previewkit namespace)
const secretStore = new SecretStore(kc);

// AWS Secrets Manager -> K8s ExternalSecret bridge
const awsExternalSecretManager = new AwsExternalSecretManager(kc, env.CLUSTER_SECRET_STORE_NAME);

// Deployer
const deployer = new Deployer(
    kc,
    env.PREVIEW_DOMAIN,
    { name: env.GATEWAY_NAME, namespace: env.GATEWAY_NAMESPACE, listener: env.GATEWAY_LISTENER },
    gatewaySubnetCidrs,
    awsExternalSecretManager,
);

// Pipelines
const previewPipeline = new PreviewPipeline({
    provider: githubProvider,
    builder,
    deployer,
    secretStore,
    registryUrl: env.REGISTRY_URL,
});

const teardownPipeline = new TeardownPipeline({
    provider: githubProvider,
    deployer,
    secretStore,
});

// HTTP server
const app = createApp({ previewPipeline, teardownPipeline, deployer, secretStore });

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info(`Previewkit listening on http://localhost:${info.port}`);
});

// Graceful shutdown
async function shutdown() {
    logger.info("Shutting down...");
    server.close();
    process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
