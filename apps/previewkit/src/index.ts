import { serve } from "@hono/node-server";
import * as k8s from "@kubernetes/client-node";
import { createApp } from "./app";
import { BuildKitBuilder } from "./builder/buildkit-builder";
import { Deployer } from "./deployer/deployer";
import { env } from "./env";
import { GitHubProvider } from "./git-provider/github-provider";
import { logger } from "./logger";
import { PreviewPipeline } from "./pipeline/preview-pipeline";
import { TeardownPipeline } from "./pipeline/teardown-pipeline";
import { SecretStore } from "./secrets/secret-store";

// Kubernetes client
const kc = new k8s.KubeConfig();
if (env.KUBECONFIG) {
    kc.loadFromFile(env.KUBECONFIG);
} else {
    kc.loadFromDefault();
}

// Git provider
const githubProvider = new GitHubProvider({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
});

// Builder
const builder = new BuildKitBuilder({
    buildkitHost: env.BUILDKIT_HOST,
});

// Deployer
const deployer = new Deployer(kc, env.PREVIEW_DOMAIN);

// Secret store (K8s Secrets in the previewkit namespace)
const secretStore = new SecretStore(kc);

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
