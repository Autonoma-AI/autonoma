import type { BuildLogSink } from "@autonoma/logger/build-log-sink";
import { LokiBuildLogSink } from "@autonoma/logger/loki-build-log-sink";
import { S3Storage } from "@autonoma/storage";
import * as k8s from "@kubernetes/client-node";
import { AddonManager } from "./addons/addon-manager";
import { OrgSecretResolver } from "./addons/org-secret-resolver";
import { NeonProvider } from "./addons/providers/neon";
import { AddonProviderRegistry } from "./addons/registry";
import { BuildQueue } from "./builder/build-queue";
import { BuildKitBuilder } from "./builder/buildkit-builder";
import { createPreviewkitDefaults } from "./config";
import { Deployer } from "./deployer/deployer";
import { EksKubeconfigLoader } from "./deployer/eks-kubeconfig";
import { env } from "./env";
import { GitHubProvider } from "./git-provider/github-provider";
import { logger } from "./logger";
import { PreviewPipeline } from "./pipeline/preview-pipeline";
import { TeardownPipeline } from "./pipeline/teardown-pipeline";
import { AwsExternalSecretManager } from "./secrets/aws-external-secret-manager";
import { AwsSecretsFetcher } from "./secrets/aws-secrets-fetcher";

/**
 * Everything a preview run needs (pipelines + GitHub provider + heavy
 * k8s/AWS/buildkit clients). The one-shot runner entry point
 * (`src/runner/index.ts`) builds this once per Job before executing the
 * deploy/teardown/redeploy pipeline.
 */
export interface PreviewkitServices {
    previewPipeline: PreviewPipeline;
    teardownPipeline: TeardownPipeline;
    githubProvider: GitHubProvider;
    /** Build-log sink; exposed so the runner can drain it before it exits. */
    buildLogSink?: BuildLogSink;
}

export async function createPreviewkitServices(): Promise<PreviewkitServices> {
    // Kubernetes client for the preview (target) cluster.
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

    // Build-log sink. When LOKI_URL is set, the builder mirrors each output
    // chunk and the pipeline mirrors phase/status transitions into Grafana
    // Loki, keyed by namespace; the autonoma API reads them back and relays to
    // the browser over SSE. The sink is best-effort (a Loki outage never fails
    // a build), so an unset URL just disables publishing.
    const logSink = createBuildLogSink();

    // Platform-owned defaults applied to every preview (registry, domain, build
    // timeout, standard resources). Single source of truth read below.
    const previewkitDefaults = createPreviewkitDefaults(env);

    // Builder. Every build dials the warm buildkitd pool in the control
    // cluster via in-cluster DNS. The BuildKit layer cache shares the storage
    // bucket with build logs; each writes under a distinct top-level key
    // prefix so they can coexist. When the admission queue is on, each build
    // first claims a per-pod slot and dials that pod directly; the Service
    // host remains the fail-open fallback.
    const buildQueue = createBuildQueue();
    const builder = new BuildKitBuilder({
        warmHost: env.BUILDKIT_WARM_HOST,
        buildTimeoutMs: previewkitDefaults.defaults.buildTimeoutMs,
        storage,
        ...(logSink != null ? { logSink } : {}),
        ...(buildQueue != null ? { queue: buildQueue } : {}),
    });

    // AWS Secrets Manager -> K8s ExternalSecret bridge.
    const awsExternalSecretManager = new AwsExternalSecretManager(kc, env.CLUSTER_SECRET_STORE_NAME);

    // AWS Secrets Manager direct fetcher for build-time secrets.
    const awsSecretsFetcher = new AwsSecretsFetcher(env.S3_REGION);

    // Deployer
    const deployer = new Deployer(
        kc,
        previewkitDefaults.defaults.domain,
        env.PREVIEW_URL_SECRET,
        awsExternalSecretManager,
        env.INGRESS_NAMESPACE,
        env.DEPLOY_TIMEOUT_MS,
        env.GATEKEEPER_IDLE_TIMEOUT,
        env.DOCKER_HUB_MIRROR,
    );

    // Addon plugin registry + manager.
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
        registryUrl: previewkitDefaults.defaults.registry,
        dockerHubMirror: env.DOCKER_HUB_MIRROR,
        storage,
        ...(logSink != null ? { logSink } : {}),
    });

    const teardownPipeline = new TeardownPipeline({
        provider: githubProvider,
        deployer,
        addonManager,
    });

    return {
        previewPipeline,
        teardownPipeline,
        githubProvider,
        ...(logSink != null ? { buildLogSink: logSink } : {}),
    };
}

/**
 * Builds the optional build-log sink. Returns undefined - disabling build-log
 * publishing - when LOKI_URL is unset, so a missing backend can never take
 * down the HTTP server or the Temporal worker (both call
 * createPreviewkitServices at startup).
 */
function createBuildLogSink(): BuildLogSink | undefined {
    if (env.LOKI_URL == null) {
        logger.warn("LOKI_URL not set - build-log streaming is disabled");
        return undefined;
    }
    return new LokiBuildLogSink(env.LOKI_URL);
}

/**
 * Builds the optional warm-pool admission queue. The queue talks to the
 * CONTROL cluster (the one the runner Job itself executes in, where the
 * buildkit pool lives), so it always uses the pod's own in-cluster
 * credentials - never the deployer's preview-cluster (EKS) client. Returns
 * undefined - disabling admission control - when the queue is switched off or
 * no local kube context can be loaded (local dev outside a cluster).
 */
function createBuildQueue(): BuildQueue | undefined {
    if (!env.BUILDKIT_QUEUE_ENABLED) {
        logger.warn("BUILDKIT_QUEUE_ENABLED=false - builds dial the warm pool without admission control");
        return undefined;
    }
    try {
        const controlKc = new k8s.KubeConfig();
        controlKc.loadFromDefault();
        return new BuildQueue({
            leaseApi: controlKc.makeApiClient(k8s.CoordinationV1Api),
            podsApi: controlKc.makeApiClient(k8s.CoreV1Api),
            fallbackAddr: env.BUILDKIT_WARM_HOST,
            slotsPerPod: env.BUILDKIT_QUEUE_SLOTS_PER_POD,
            maxWaitMs: env.BUILDKIT_QUEUE_MAX_WAIT_MS,
            pollIntervalMs: env.BUILDKIT_QUEUE_POLL_MS,
        });
    } catch (err) {
        logger.warn("Failed to load control-cluster kube config - build queue disabled", { err });
        return undefined;
    }
}
