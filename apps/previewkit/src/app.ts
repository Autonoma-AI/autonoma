import { type CallerAuthVariables, requireApiKeyOrService } from "@autonoma/auth";
import { db } from "@autonoma/db";
import { Hono } from "hono";
import type { Deployer } from "./deployer/deployer";
import type { PreviewPipeline } from "./pipeline/preview-pipeline";
import type { TeardownPipeline } from "./pipeline/teardown-pipeline";
import { docsRoute } from "./routes/docs.route";
import { createEnvironmentsRoute } from "./routes/environments.route";
import { healthRoute } from "./routes/health.route";
import { createSecretsRoute } from "./routes/secrets.route";
import type { PreviewkitSecretsService } from "./secrets/secrets-service";

/** Typed Hono environment so `c.var.authCaller` is inferred end-to-end. */
export type PreviewkitHonoEnv = { Variables: CallerAuthVariables };

interface AppOptions {
    previewPipeline: PreviewPipeline;
    teardownPipeline: TeardownPipeline;
    deployer: Deployer;
    secretsService: PreviewkitSecretsService;
    /** Shared secret for service-to-service calls (autonoma -> previewkit).
     *  Unset disables the service-secret path; only API-key callers will
     *  succeed. Suitable for local dev. */
    serviceSecret: string | undefined;
}

export function createApp(options: AppOptions) {
    const app = new Hono<PreviewkitHonoEnv>();

    // /health stays unauthenticated - it's a kubelet liveness probe.
    app.route("/", healthRoute);

    // Every /v1/* route is behind the auth middleware. Routes that the
    // autonoma webhook forwarder calls accept the service-secret path;
    // routes called by external clients accept the API-key path.
    app.use("/v1/*", requireApiKeyOrService({ db, serviceSecret: options.serviceSecret }));

    app.route(
        "/v1",
        createEnvironmentsRoute({
            previewPipeline: options.previewPipeline,
            teardownPipeline: options.teardownPipeline,
            deployer: options.deployer,
        }),
    );
    app.route("/v1", createSecretsRoute(options.secretsService));
    app.route("/v1", docsRoute);

    return app;
}
