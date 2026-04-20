import { Hono } from "hono";
import type { Deployer } from "./deployer/deployer";
import type { PreviewPipeline } from "./pipeline/preview-pipeline";
import type { TeardownPipeline } from "./pipeline/teardown-pipeline";
import { docsRoute } from "./routes/docs.route";
import { createEnvironmentsRoute } from "./routes/environments.route";
import { healthRoute } from "./routes/health.route";
import { createSecretsRoute } from "./routes/secrets.route";
import type { SecretStore } from "./secrets/secret-store";

interface AppOptions {
    previewPipeline: PreviewPipeline;
    teardownPipeline: TeardownPipeline;
    deployer: Deployer;
    secretStore: SecretStore;
}

export function createApp(options: AppOptions) {
    const app = new Hono();

    app.route("/", healthRoute);
    app.route(
        "/v1",
        createEnvironmentsRoute({
            previewPipeline: options.previewPipeline,
            teardownPipeline: options.teardownPipeline,
            deployer: options.deployer,
        }),
    );
    app.route("/v1", createSecretsRoute(options.secretStore));
    app.route("/v1", docsRoute);

    return app;
}
