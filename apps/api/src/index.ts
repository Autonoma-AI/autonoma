import { logger } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import { createApiApp, shutdownApi } from "./app";
import { bootstrapApiRuntime } from "./bootstrap";
import { env } from "./env";
import { startApiServer } from "./start-api-server";

bootstrapApiRuntime();

const app = createApiApp();
const port = Number.parseInt(env.API_PORT);

const server = startApiServer({ app, port, logger });

async function shutdown() {
    server.close();
    await shutdownApi();
    await Sentry.flush();
    process.exit(0);
}

process.on("SIGTERM", () => {
    void shutdown();
});

process.on("SIGINT", () => {
    void shutdown();
});
