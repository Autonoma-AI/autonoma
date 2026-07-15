import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { logger } from "@autonoma/logger";
import { serve } from "@hono/node-server";
import * as Sentry from "@sentry/node";
import { createApiApp, shutdownApi } from "./app";
import { bootstrapApiRuntime } from "./bootstrap";
import { env } from "./env";

bootstrapApiRuntime();

const app = createApiApp();

function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const tester = createServer()
            .once("error", () => resolve(false))
            .once("listening", () => {
                tester.close(() => resolve(true));
            })
            .listen(port, "0.0.0.0");
    });
}

async function findAvailablePort(startPort: number, maxAttempts = 10): Promise<number> {
    for (let i = 0; i < maxAttempts; i++) {
        const candidate = startPort + i;
        if (await isPortAvailable(candidate)) return candidate;
        logger.info(`Port ${candidate} is in use, trying next`);
    }
    throw new Error(`No available port found after ${maxAttempts} attempts starting from ${startPort}`);
}

async function start() {
    const preferredPort = Number.parseInt(env.API_PORT);
    const port = env.NODE_ENV === "production" ? preferredPort : await findAvailablePort(preferredPort);

    if (env.NODE_ENV !== "production") {
        try {
            const portFile = resolve(process.cwd(), ".api-port");
            writeFileSync(portFile, String(port));
        } catch (error) {
            logger.warn("Failed to write local API port file", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    logger.info(`Server running on port ${port}`);

    const server = serve({ fetch: app.fetch, port });

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
}

void start();
