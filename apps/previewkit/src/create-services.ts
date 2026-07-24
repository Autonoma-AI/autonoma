import type { BuildLogSink } from "@autonoma/logger/build-log-sink";
import { LokiBuildLogSink } from "@autonoma/logger/loki-build-log-sink";
import * as k8s from "@kubernetes/client-node";
import { AddonManager } from "./addons/addon-manager";
import { OrgSecretResolver } from "./addons/org-secret-resolver";
import { NeonProvider } from "./addons/providers/neon";
import { AddonProviderRegistry } from "./addons/registry";
import { BuildKitBuilder } from "./builder/buildkit-builder";
import { BuildKitJobManager } from "./builder/buildkit-job-manager";
import { createPreviewkitDefaults } from "./config";
import { Deployer } from "./deployer/deployer";
import { EksKubeconfigLoader } from "./deployer/eks-kubeconfig";
import { resolveNpmRegistryMirror } from "./dockerfile-builder/resolve-npm-registry-mirror";
import { env } from "./env";
import { GitHubProvider } from "./git-provider/github-provider";
import { logger } from "./logger";
import { PreviewPipeline } from "./pipeline/preview-pipeline";
import { TeardownPipeline } from "./pipeline/teardown-pipeline";
import { AwsExternalSecretManager } from "./secrets/aws-external-secret-manager";
import { AwsSecretsFetcher } from "./secrets/aws-secrets-fetcher";

const BUILDKIT_DIAL_BUDGET_MS = 30_000;
const BUILDKIT_LIFECYCLE_MARGIN_MS = 60_000;
const EKS_TOKEN_REFRESH_INTERVAL_MS = 30_000;

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
    /** Exposed so runner shutdown can retry cleanup for every active build Job. */
    buildkitJobManager?: BuildKitJobManager;
}

export async function createPreviewkitServices(): Promise<PreviewkitServices> {
    // Kubernetes client for the preview (target) cluster.
    let kc: k8s.KubeConfig;
    if (env.EKS_CLUSTER_NAME != null) {
        const staticClusterInfo =
            env.EKS_CLUSTER_ENDPOINT != null && env.EKS_CLUSTER_CA != null
                ? { endpoint: env.EKS_CLUSTER_ENDPOINT, caData: env.EKS_CLUSTER_CA }
                : undefined;
        const loader = new EksKubeconfigLoader(env.EKS_CLUSTER_NAME, env.AWS_REGION, staticClusterInfo);
        kc = await loader.load();
        // Force a fresh token halfway through its 60-second validity window.
        // refresh() mutates the existing kc object in place, so all API clients
        // pick up the new token without rebuilding their clients.
        setInterval(() => {
            loader.refresh().catch((err) => logger.error("Failed to refresh EKS kubeconfig token", err));
        }, EKS_TOKEN_REFRESH_INTERVAL_MS);
    } else {
        kc = new k8s.KubeConfig();
        if (env.KUBECONFIG != null) {
            kc.loadFromFile(env.KUBECONFIG);
        } else {
            kc.loadFromDefault();
        }
    }

    // The deployer uses the preview cluster client above. Buildkitd Jobs run in
    // the control cluster beside the runner, so cross-cluster production runs
    // need a separate in-cluster client for their lifecycle.
    const controlKc = new k8s.KubeConfig();
    if (env.EKS_CLUSTER_NAME != null) {
        controlKc.loadFromCluster();
    } else if (env.KUBECONFIG != null) {
        controlKc.loadFromFile(env.KUBECONFIG);
    } else {
        controlKc.loadFromDefault();
    }

    // Git provider
    const githubProvider = new GitHubProvider({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_PRIVATE_KEY,
    });

    // Build-log sink. When LOKI_URL is set, the builder mirrors each output
    // chunk and the pipeline mirrors phase/status transitions into Grafana
    // Loki, keyed by namespace; the autonoma API reads them back and relays to
    // the browser over SSE. The sink is best-effort (a Loki outage never fails
    // a build), so an unset URL just disables publishing.
    const logSink = createBuildLogSink();

    // Platform-owned defaults applied to every preview (registry, domain, build
    // timeout, standard resources). Single source of truth read below.
    const previewkitDefaults = createPreviewkitDefaults(env);

    // Local build preparation completes before each app-build attempt requests
    // its privileged rootful buildkitd Job. The Job deadline therefore covers
    // node provisioning, daemon startup, TCP dialing, buildctl, and a lifecycle
    // margin without coupling two independent command timeouts.
    const buildkitJobDeadlineMs =
        env.BUILD_READINESS_TIMEOUT_MS +
        env.BUILD_STARTUP_TIMEOUT_MS +
        previewkitDefaults.defaults.buildTimeoutMs +
        BUILDKIT_DIAL_BUDGET_MS +
        BUILDKIT_LIFECYCLE_MARGIN_MS;
    const buildkitJobManager = new BuildKitJobManager({
        batchApi: controlKc.makeApiClient(k8s.BatchV1Api),
        podsApi: controlKc.makeApiClient(k8s.CoreV1Api),
        namespace: env.BUILDKIT_BUILD_NAMESPACE,
        image: env.BUILDKIT_IMAGE,
        activeDeadlineSeconds: Math.ceil(buildkitJobDeadlineMs / 1000),
        provisionTimeoutMs: env.BUILD_READINESS_TIMEOUT_MS,
        startupTimeoutMs: env.BUILD_STARTUP_TIMEOUT_MS,
    });
    // Probed once per deploy (this process is a per-deploy Job), so an unhealthy
    // mirror degrades every install in this build to the public registry instead
    // of failing it.
    const npmRegistryMirror = await resolveNpmRegistryMirror(env.NPM_REGISTRY_MIRROR);

    const builder = new BuildKitBuilder({
        jobManager: buildkitJobManager,
        buildTimeoutMs: previewkitDefaults.defaults.buildTimeoutMs,
        npmRegistryMirror,
        ...(logSink != null ? { logSink } : {}),
    });

    // AWS Secrets Manager -> K8s ExternalSecret bridge.
    const awsExternalSecretManager = new AwsExternalSecretManager(kc, env.CLUSTER_SECRET_STORE_NAME);

    // AWS Secrets Manager direct fetcher for build-time secrets.
    const awsSecretsFetcher = new AwsSecretsFetcher(env.AWS_REGION);

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
        npmRegistryMirror,
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
        buildkitJobManager,
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
