import { runWithSentry } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { serve } from "@hono/node-server";
import * as k8s from "@kubernetes/client-node";
import { AddonManager } from "./addons/addon-manager";
import { OrgSecretResolver } from "./addons/org-secret-resolver";
import { NeonProvider } from "./addons/providers/neon";
import { AddonProviderRegistry } from "./addons/registry";
import { createApp } from "./app";
import { BuildKitBuilder } from "./builder/buildkit-builder";
import { BuildKitJobManager } from "./builder/buildkit-job-manager";
import { Deployer } from "./deployer/deployer";
import { EksKubeconfigLoader } from "./deployer/eks-kubeconfig";
import { env } from "./env";
import { GitHubProvider } from "./git-provider/github-provider";
import { logger } from "./logger";
import { PreviewPipeline } from "./pipeline/preview-pipeline";
import { TeardownPipeline } from "./pipeline/teardown-pipeline";
import { AwsExternalSecretManager } from "./secrets/aws-external-secret-manager";
import { AwsSecretsFetcher } from "./secrets/aws-secrets-fetcher";
import { PreviewkitSecretsService } from "./secrets/secrets-service";

runWithSentry({ name: "previewkit", dsn: env.SENTRY_DSN }, async () => {
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

    // Local cluster kubeconfig (cluster A - same cluster previewkit itself
    // runs in). `kc` above points at the preview cluster (B) and is used by
    // the Deployer; `localKc` is used by the BuildKitJobManager to spawn
    // ephemeral buildkitd Jobs alongside previewkit.
    //
    // In production, EKS_CLUSTER_NAME is set and `kc` is for cluster B; here
    // we mount the pod's in-cluster ServiceAccount token to reach the control
    // plane. In local dev there's only one cluster, so the same kc serves
    // both roles.
    let localKc: k8s.KubeConfig;
    if (env.EKS_CLUSTER_NAME != null) {
        localKc = new k8s.KubeConfig();
        localKc.loadFromCluster();
    } else {
        localKc = kc;
    }

    // Git provider
    const githubProvider = new GitHubProvider({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_PRIVATE_KEY,
    });

    // Object storage for build logs. Reads S3_* env from @autonoma/storage/env.
    const storage = S3Storage.createFromEnv();

    // Per-build buildkitd lifecycle. The manager spins up an ephemeral Job +
    // Service per app build in cluster A, and the builder dials it via
    // in-cluster DNS. `activeDeadlineSeconds` is a K8s-level kill switch in
    // case previewkit crashes mid-build; we set it to BUILD_TIMEOUT_MS + 60s
    // so it never fires before the buildctl-level timeout.
    const buildkitJobManager = new BuildKitJobManager({
        kc: localKc,
        namespace: env.BUILDKIT_BUILD_NAMESPACE,
        image: env.BUILDKIT_IMAGE,
        serviceAccountName: env.BUILDKIT_BUILDER_SERVICE_ACCOUNT,
        activeDeadlineSeconds: Math.ceil(env.BUILD_TIMEOUT_MS / 1000) + 60,
    });

    // Builder. The BuildKit layer cache shares the storage bucket with build logs;
    // each writes under a distinct top-level key prefix so they can coexist.
    const builder = new BuildKitBuilder({
        jobManager: buildkitJobManager,
        buildTimeoutMs: env.BUILD_TIMEOUT_MS,
        storage,
    });

    const gatewaySubnetCidrs = env.GATEWAY_SUBNET_CIDRS
        ? env.GATEWAY_SUBNET_CIDRS.split(",")
              .map((s) => s.trim())
              .filter(Boolean)
        : [];

    // AWS Secrets Manager -> K8s ExternalSecret bridge. Every per-app secret
    // bundle lands in the preview namespace as a K8s Secret and is mounted
    // into the Deployment via `envFrom: secretRef`. There is no separate
    // in-cluster SecretStore anymore — AWS Secrets Manager is the single
    // source of truth for runtime credentials.
    const awsExternalSecretManager = new AwsExternalSecretManager(kc, env.CLUSTER_SECRET_STORE_NAME);

    // AWS Secrets Manager direct fetcher — for build-time secrets that need to
    // land in `build_args` before the build runs (i.e. before any K8s Secret
    // would be materialised via ExternalSecret CRs). Uses S3_REGION since the
    // previewkit pod's existing IAM role is region-scoped to it.
    const awsSecretsFetcher = new AwsSecretsFetcher(env.S3_REGION);

    // CRUD over the per-app AWS Secrets Manager bundles, exposed via the
    // HTTP /v1/secrets routes. Mirrors the autonoma API's tRPC `secrets`
    // route for callers that prefer curl over a typed client.
    const secretsService = new PreviewkitSecretsService(env.S3_REGION);

    // Deployer
    const deployer = new Deployer(
        kc,
        env.PREVIEW_DOMAIN,
        { name: env.GATEWAY_NAME, namespace: env.GATEWAY_NAMESPACE, listener: env.GATEWAY_LISTENER },
        gatewaySubnetCidrs,
        awsExternalSecretManager,
    );

    // Addon plugin registry + manager. Built-in providers are registered
    // here; new providers (PlanetScale, Upstash, ...) just append to this
    // list. The OrgSecretResolver shares the AwsSecretsFetcher with the
    // build-time secret machinery — same AWS SM, different scope (org vs
    // app), same JSON-map convention.
    const addonProviderRegistry = new AddonProviderRegistry();
    addonProviderRegistry.register(new NeonProvider());
    const orgSecretResolver = new OrgSecretResolver(awsSecretsFetcher);
    const addonManager = new AddonManager(addonProviderRegistry, orgSecretResolver);

    // Pipelines
    const previewPipeline = new PreviewPipeline({
        provider: githubProvider,
        builder,
        deployer,
        awsSecretsFetcher,
        addonManager,
        registryUrl: env.REGISTRY_URL,
    });

    const teardownPipeline = new TeardownPipeline({
        provider: githubProvider,
        deployer,
        addonManager,
    });

    // HTTP server. All /v1/* routes require either the API-key Bearer
    // header (external callers) or the service shared secret (internal
    // service-to-service from the autonoma API). /health stays open for
    // kubelet probes.
    const app = createApp({
        previewPipeline,
        teardownPipeline,
        deployer,
        secretsService,
        serviceSecret: env.AUTONOMA_SERVICE_SECRET,
    });

    const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
        logger.info(`Previewkit listening on http://localhost:${info.port}`);
    });

    await new Promise<void>((resolve) => {
        const shutdown = (signal: NodeJS.Signals) => {
            logger.info("Shutting down...", { signal });
            server.close();
            resolve();
        };
        process.once("SIGTERM", () => shutdown("SIGTERM"));
        process.once("SIGINT", () => shutdown("SIGINT"));
    });
});
