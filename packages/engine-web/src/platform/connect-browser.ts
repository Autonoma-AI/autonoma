import { logger as rootLogger } from "@autonoma/logger";
import { sleep } from "@autonoma/utils/sleep";
import { chromium } from "playwright";
import { connectRemoteBrowser } from "./drivers/connect-remote-browser";
import { env } from "./env";

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const REMOTE_BROWSER_HEALTH_TIMEOUT_MS = 90_000;
const REMOTE_BROWSER_HEALTH_POLL_MS = 1_000;

export { DEFAULT_VIEWPORT };

export async function connectBrowser() {
    const logger = rootLogger.child({ name: "connect-browser" });

    if (env.REMOTE_BROWSER_URL != null) {
        logger.info("Connecting to remote browser", { endpoint: env.REMOTE_BROWSER_URL });

        await waitForRemoteBrowserHealth(env.REMOTE_BROWSER_URL, logger);

        const maxAttempts = 10;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await connectRemoteBrowser({
                    remoteChromeEndpoint: env.REMOTE_BROWSER_URL,
                    viewport: DEFAULT_VIEWPORT,
                });
            } catch (error) {
                if (attempt === maxAttempts) throw error;
                logger.warn(`Browser not ready, retrying (${attempt}/${maxAttempts})...`);
                await new Promise((r) => setTimeout(r, 2000));
            }
        }
    }

    logger.info("Launching local browser");
    return await chromium.launch({ headless: env.HEADLESS === "true" });
}

async function waitForRemoteBrowserHealth(endpoint: string, logger: ReturnType<typeof rootLogger.child>) {
    const healthUrl =
        endpoint.startsWith("http://") || endpoint.startsWith("https://")
            ? `${endpoint.replace(/\/$/, "")}/json/version`
            : `http://${endpoint.replace(/\/$/, "")}/json/version`;
    const startedAt = Date.now();

    while (Date.now() - startedAt < REMOTE_BROWSER_HEALTH_TIMEOUT_MS) {
        try {
            const response = await fetch(healthUrl);
            if (response.ok) {
                logger.info("Remote browser healthcheck is ready", { healthUrl });
                return;
            }
        } catch {
            // Browser sidecar may still be starting up; keep polling.
        }

        await sleep(REMOTE_BROWSER_HEALTH_POLL_MS);
    }

    throw new Error(`Remote browser healthcheck timeout after ${REMOTE_BROWSER_HEALTH_TIMEOUT_MS}ms: ${healthUrl}`);
}
